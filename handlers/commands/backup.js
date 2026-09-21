import { getPool } from '../../database/connector.js';
import { finished, pipeline } from 'stream/promises';
import { createGzip } from 'zlib';
import {
    createReadStream,
    createWriteStream
} from 'fs';
import fs from 'fs/promises';
import path from 'path';
import cron from 'node-cron';
import * as db from '../../database.js';
import {
    sendMessageSafe,
    editMessageSafe
} from '../../utils/textFormatter.js';
import { isOwner } from '../../utils/ownerCheck.js';
import { character } from '../../character.js';

const MAX_TELEGRAM_FILE_SIZE =
    50 * 1024 * 1024;

const BACKUP_DIR =
    './backups';

const BACKUP_CHUNK_SIZE =
    500;

function formatFileSize(bytes) {
    if (bytes < 1024) {
        return `${bytes} B`;
    }

    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(2)} KB`;
    }

    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function ensureBackupDir() {
    try {
        await fs.access(BACKUP_DIR);
    } catch {
        await fs.mkdir(
            BACKUP_DIR,
            {
                recursive: true
            }
        );
    }
}

async function getFileSize(filePath) {
    const stats =
        await fs.stat(filePath);

    return stats.size;
}

async function writeStreamChunk(
    stream,
    content
) {
    if (
        stream.write(
            content,
            'utf8'
        )
    ) {
        return;
    }

    await new Promise(resolve => {
        stream.once(
            'drain',
            resolve
        );
    });
}

async function createDatabaseBackup() {
    await ensureBackupDir();

    const timestamp =
        new Date()
            .toISOString()
            .replace(/[:.]/g, '-')
            .slice(0, -5);

    const filename =
        `${character.firstname.toLowerCase()}_backup_${timestamp}.sql`;

    const filepath =
        path.join(
            BACKUP_DIR,
            filename
        );

    const pool =
        getPool();

    const connection =
        await pool.getConnection();

    let output = null;
    let outputFinished = null;
    let transactionStarted = false;

    try {
        output =
            createWriteStream(
                filepath,
                {
                    encoding: 'utf8'
                }
            );

        /*
         * Start listening for stream errors immediately.
         * This prevents stream errors from being missed
         * before finished() is awaited later.
         */
        outputFinished =
            finished(output);

        await connection.query(
            'START TRANSACTION WITH CONSISTENT SNAPSHOT'
        );

        transactionStarted = true;

        const [tableRows] =
            await connection.query(
                'SHOW FULL TABLES'
            );

        const tables =
            tableRows
                .map(row => {
                    const keys =
                        Object.keys(row);

                    const nameKey =
                        keys.find(
                            key =>
                                key.toLowerCase() !==
                                'table_type'
                        );

                    const typeKey =
                        keys.find(
                            key =>
                                key.toLowerCase() ===
                                'table_type'
                        );

                    return {
                        name: row[nameKey],
                        type: row[typeKey]
                    };
                })
                .filter(
                    table =>
                        String(table.type)
                            .toUpperCase() ===
                        'BASE TABLE'
                );

        if (
            tables.length === 0
        ) {
            throw new Error(
                'No database tables were found.'
            );
        }

        const definitions = [];

        for (const table of tables) {
            const escapedTableName =
                connection.escapeId(
                    table.name
                );

            const [createRows] =
                await connection.query(
                    `SHOW CREATE TABLE ${escapedTableName}`
                );

            const createSql =
                createRows[0]?.['Create Table'];

            if (!createSql) {
                throw new Error(
                    `Could not read schema for table: ${table.name}`
                );
            }

            const [columnRows] =
                await connection.query(
                    `SHOW COLUMNS FROM ${escapedTableName}`
                );

            const columns =
                columnRows.map(
                    column =>
                        column.Field
                );

            const [primaryRows] =
                await connection.query(
                    `SHOW KEYS FROM ${escapedTableName}
                     WHERE Key_name = 'PRIMARY'
                     ORDER BY Seq_in_index`
                );

            /*
             * Use primary-key pagination only when
             * the table has exactly one primary-key column.
             *
             * Tables without a single-column PK use OFFSET.
             */
            const primaryColumn =
                primaryRows.length === 1
                    ? primaryRows[0].Column_name
                    : null;

            definitions.push({
                name: table.name,
                escapedName: escapedTableName,
                createSql,
                columns,
                primaryColumn
            });
        }

        await writeStreamChunk(
            output,
            '-- RedStar Database Backup\n' +
            `-- Generated: ${new Date().toISOString()}\n\n` +
            'SET NAMES utf8mb4;\n' +
            'SET FOREIGN_KEY_CHECKS=0;\n\n'
        );

        /*
         * Drop tables first so the generated SQL can
         * restore an existing database.
         */
        for (
            const table of definitions
        ) {
            await writeStreamChunk(
                output,
                `DROP TABLE IF EXISTS ${table.escapedName};\n`
            );
        }

        await writeStreamChunk(
            output,
            '\n'
        );

        /*
         * Restore table definitions.
         */
        for (
            const table of definitions
        ) {
            await writeStreamChunk(
                output,
                `${table.createSql};\n\n`
            );
        }

        /*
         * Restore table data.
         */
        for (
            const table of definitions
        ) {
            let rowsExported = 0;
            let lastPrimaryValue = null;

            while (true) {
                let rows;

                if (
                    table.primaryColumn
                ) {
                    if (
                        lastPrimaryValue === null
                    ) {
                        [rows] =
                            await connection.query(
                                `SELECT *
                                 FROM ${table.escapedName}
                                 ORDER BY ${connection.escapeId(table.primaryColumn)} ASC
                                 LIMIT ${BACKUP_CHUNK_SIZE}`
                            );
                    } else {
                        [rows] =
                            await connection.query(
                                `SELECT *
                                 FROM ${table.escapedName}
                                 WHERE ${connection.escapeId(table.primaryColumn)} > ?
                                 ORDER BY ${connection.escapeId(table.primaryColumn)} ASC
                                 LIMIT ${BACKUP_CHUNK_SIZE}`,
                                [
                                    lastPrimaryValue
                                ]
                            );
                    }
                } else {
                    [rows] =
                        await connection.query(
                            `SELECT *
                             FROM ${table.escapedName}
                             LIMIT ${BACKUP_CHUNK_SIZE}
                             OFFSET ${rowsExported}`
                        );
                }

                if (
                    rows.length === 0
                ) {
                    break;
                }

                const escapedColumns =
                    table.columns.map(
                        column =>
                            connection.escapeId(
                                column
                            )
                    );

                const values =
                    rows.map(row => {
                        const rowValues =
                            table.columns.map(
                                column => {
                                    const value =
                                        row[column];

                                    if (
                                        value === null ||
                                        value === undefined
                                    ) {
                                        return 'NULL';
                                    }

                                    return connection.escape(
                                        value
                                    );
                                }
                            );

                        return (
                            `(${rowValues.join(', ')})`
                        );
                    });

                await writeStreamChunk(
                    output,
                    `INSERT INTO ${table.escapedName} ` +
                    `(${escapedColumns.join(', ')}) VALUES\n` +
                    `${values.join(',\n')};\n`
                );

                rowsExported +=
                    rows.length;

                if (
                    table.primaryColumn
                ) {
                    lastPrimaryValue =
                        rows[
                            rows.length - 1
                        ][
                            table.primaryColumn
                        ];
                }

                if (
                    rows.length <
                    BACKUP_CHUNK_SIZE
                ) {
                    break;
                }
            }

            await writeStreamChunk(
                output,
                '\n'
            );
        }

        await writeStreamChunk(
            output,
            'SET FOREIGN_KEY_CHECKS=1;\n'
        );

        output.end();

        await outputFinished;

        await connection.commit();

        transactionStarted =
            false;

        const fileSize =
            await getFileSize(
                filepath
            );

        return {
            filepath,
            fileSize,
            filename
        };

    } catch (error) {
        if (
            transactionStarted
        ) {
            await connection
                .rollback()
                .catch(() => {});
        }

        if (output) {
            output.destroy();
        }

        try {
            await fs.unlink(
                filepath
            );
        } catch {}

        const enhancedError =
            new Error(
                `Backup failed. Error: ${error.message}`
            );

        enhancedError.originalError =
            error;

        throw enhancedError;

    } finally {
        connection.release();
    }
}

async function compressBackup(
    sqlFilePath
) {
    const gzipPath =
        `${sqlFilePath}.gz`;

    await pipeline(
        createReadStream(
            sqlFilePath
        ),
        createGzip(),
        createWriteStream(
            gzipPath
        )
    );

    const compressedSize =
        await getFileSize(
            gzipPath
        );

    await fs.unlink(
        sqlFilePath
    );

    return {
        filepath: gzipPath,
        fileSize: compressedSize
    };
}

async function cleanOldBackups() {
    try {
        const files =
            await fs.readdir(
                BACKUP_DIR
            );

        const now =
            Date.now();

        const maxAge =
            7 *
            24 *
            60 *
            60 *
            1000;

        for (
            const file of files
        ) {
            const filePath =
                path.join(
                    BACKUP_DIR,
                    file
                );

            const stats =
                await fs.stat(
                    filePath
                );

            if (
                now - stats.mtimeMs >
                maxAge
            ) {
                await fs.unlink(
                    filePath
                );
            }
        }

    } catch (error) {
        console.error(
            '[backup:cleanOldBackups] Error cleaning old backups:',
            error.message
        );
    }
}

export function scheduleAutoBackup() {
    cron.schedule(
        '0 */4 * * *',
        async () => {
            console.log(
                '[backup:scheduleAutoBackup] Starting scheduled backup...'
            );

            const backupChannel =
                await db.getBackupChannel();

            if (!backupChannel) {
                console.log(
                    '[backup:scheduleAutoBackup] No backup channel configured.'
                );

                return;
            }

            try {
                const bot =
                    global.bot;

                if (!bot) {
                    console.error(
                        '[backup:scheduleAutoBackup] Bot instance not available.'
                    );

                    return;
                }

                const statusMsg =
                    await bot.sendMessage(
                        backupChannel.channel_id,
                        '⏳ **در حال تهیه بکاپ خودکار...**\n\nلطفاً صبر کنید، این کار ممکن است چند دقیقه طول بکشد.',
                        {
                            parse_mode: 'Markdown'
                        }
                    );

                let backupFilepath =
                    null;

                try {
                    let backup =
                        await createDatabaseBackup();

                    backupFilepath =
                        backup.filepath;

                    backup =
                        await compressBackup(
                            backup.filepath
                        );

                    backupFilepath =
                        backup.filepath;

                    if (
                        backup.fileSize >
                        MAX_TELEGRAM_FILE_SIZE
                    ) {
                        await bot.editMessageText(
                            `❌ بکاپ خودکار ناموفق: حجم فایل بیش از حد مجاز (${formatFileSize(backup.fileSize)})`,
                            {
                                chat_id:
                                    backupChannel.channel_id,
                                message_id:
                                    statusMsg.message_id
                            }
                        );

                        return;
                    }

                    const jalaliDate =
                        new Date()
                            .toLocaleDateString(
                                'fa-IR'
                            );

                    const caption =
                        `✅ **بکاپ خودکار**\n\n` +
                        `📅 تاریخ: ${jalaliDate}\n` +
                        `🕐 ساعت: ${new Date().toLocaleTimeString('fa-IR')}\n` +
                        `📦 حجم: ${formatFileSize(backup.fileSize)}\n` +
                        `💾 دیتابیس: ${process.env.DB_NAME || 'Unknown'}`;

                    await bot.sendDocument(
                        backupChannel.channel_id,
                        backup.filepath,
                        {
                            caption,
                            parse_mode:
                                'Markdown'
                        }
                    );

                    await bot.deleteMessage(
                        backupChannel.channel_id,
                        statusMsg.message_id
                    ).catch(
                        () => {}
                    );

                    console.log(
                        '[backup:scheduleAutoBackup] Backup sent successfully.'
                    );

                } catch (error) {
                    console.error(
                        '[backup:scheduleAutoBackup] Error:',
                        error.message
                    );

                    await bot.editMessageText(
                        `❌ **خطا در تهیه بکاپ خودکار**\n\n*مشکل:* ${error.message || 'خطایی ناشناخته'}`,
                        {
                            chat_id:
                                backupChannel.channel_id,
                            message_id:
                                statusMsg.message_id,
                            parse_mode:
                                'Markdown'
                        }
                    ).catch(
                        () => {}
                    );

                } finally {
                    if (
                        backupFilepath
                    ) {
                        try {
                            await fs.unlink(
                                backupFilepath
                            );
                        } catch (error) {
                            console.error(
                                `[backup:scheduleAutoBackup] Failed to delete: ${error.message}`
                            );
                        }
                    }
                }

            } catch (error) {
                console.error(
                    '[backup:scheduleAutoBackup] Fatal error:',
                    error.message
                );
            }
        },
        {
            scheduled: true,
            timezone: 'UTC'
        }
    );

    console.log(
        '[backup:scheduleAutoBackup] Scheduled every 4 hours.'
    );
}

export async function sendCriticalAlert(
    message
) {
    try {
        const bot =
            global.bot;

        if (!bot) {
            return;
        }

        const backupChannel =
            await db.getBackupChannel();

        if (!backupChannel) {
            return;
        }

        const alertText =
            `🚨 **هشدار بحرانی**\n\n${message}\n\n⏰ زمان: ${new Date().toLocaleString('fa-IR')}`;

        await bot.sendMessage(
            backupChannel.channel_id,
            alertText,
            {
                parse_mode:
                    'Markdown'
            }
        );

    } catch (error) {
        console.error(
            '[backup:sendCriticalAlert] Failed to send alert:',
            error.message
        );
    }
}

export async function handleBackupCommand(
    bot,
    msg
) {
    if (
        !isOwner(msg.from.id)
    ) {
        return;
    }

    const statusMsg =
        await sendMessageSafe(
            bot,
            msg.chat.id,
            '⏳ **در حال تهیه پشتیبان از دیتابیس...**\n\nلطفاً صبر کنید، این کار ممکن است چند دقیقه طول بکشد.',
            {
                reply_to_message_id:
                    msg.message_id
            }
        );

    let backupFilepath =
        null;

    try {
        await editMessageSafe(
            bot,
            msg.chat.id,
            statusMsg.message_id,
            '🔄 **مرحله ۱/۳:** دریافت داده‌ها از MariaDB...'
        );

        let backup =
            await createDatabaseBackup();

        backupFilepath =
            backup.filepath;

        await editMessageSafe(
            bot,
            msg.chat.id,
            statusMsg.message_id,
            `🔄 **مرحله ۲/۳:** فشرده‌سازی فایل backup (${formatFileSize(backup.fileSize)})...`
        );

        backup =
            await compressBackup(
                backup.filepath
            );

        backupFilepath =
            backup.filepath;

        if (
            backup.fileSize >
            MAX_TELEGRAM_FILE_SIZE
        ) {
            const errorText =
                `❌ **خطا: حجم فایل زیاد است**\n\n` +
                `حجم فایل backup: ${formatFileSize(backup.fileSize)}\n` +
                `حداکثر مجاز تلگرام: ${formatFileSize(MAX_TELEGRAM_FILE_SIZE)}\n\n` +
                `لطفاً فایل بکاپ را خارج از تلگرام ذخیره یا منتقل کنید.`;

            await editMessageSafe(
                bot,
                msg.chat.id,
                statusMsg.message_id,
                errorText
            );

            await fs.unlink(
                backupFilepath
            ).catch(
                () => {}
            );

            backupFilepath =
                null;

            return;
        }

        await editMessageSafe(
            bot,
            msg.chat.id,
            statusMsg.message_id,
            `🔄 **مرحله ۳/۳:** ارسال فایل backup (${formatFileSize(backup.fileSize)})...`
        );

        const caption =
            `✅ **Backup موفق**\n\n` +
            `📅 تاریخ: ${new Date().toLocaleString('fa-IR')}\n` +
            `📦 حجم: ${formatFileSize(backup.fileSize)}\n` +
            `💾 دیتابیس: ${process.env.DB_NAME || 'Unknown'}\n\n` +
            `برای بازیابی:\n` +
            `\`gunzip < backup.sql.gz | mysql -u user -p dbname\``;

        await bot.sendDocument(
            msg.chat.id,
            backup.filepath,
            {
                caption,
                parse_mode:
                    'Markdown'
            }
        );

        await bot.deleteMessage(
            msg.chat.id,
            statusMsg.message_id
        ).catch(
            () => {}
        );

    } catch (error) {
        console.error(
            '❌ [backup:handleBackupCommand] CRITICAL ERROR:',
            error.originalError ||
            error
        );

        const errorMessage =
            `❌ **خطا در تهیه پشتیبان**\n\n` +
            `*مشکل:* ${error.message || 'خطای ناشناخته'}\n\n` +
            `اطمینان حاصل کنید اتصال دیتابیس برقرار است و دوباره تلاش کنید.`;

        await editMessageSafe(
            bot,
            msg.chat.id,
            statusMsg.message_id,
            errorMessage
        ).catch(
            () => {
                bot.sendMessage(
                    msg.chat.id,
                    errorMessage
                ).catch(
                    () => {}
                );
            }
        );

    } finally {
        if (
            backupFilepath
        ) {
            try {
                await fs.unlink(
                    backupFilepath
                );
            } catch (error) {
                console.error(
                    `[backup:handleBackupCommand] Failed to delete temporary file ${backupFilepath}:`,
                    error.message
                );
            }
        }

        await cleanOldBackups();
    }
}