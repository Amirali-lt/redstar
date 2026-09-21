import { getPool } from '../../database/connector.js';
import { createGzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { createReadStream, createWriteStream } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import cron from 'node-cron';
import * as db from '../../database.js';
import { sendMessageSafe, editMessageSafe } from '../../utils/textFormatter.js';
import { isOwner } from '../../utils/ownerCheck.js';
import { character } from '../../character.js';



const MAX_TELEGRAM_FILE_SIZE = 50 * 1024 * 1024;
const BACKUP_DIR = './backups';

function formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function ensureBackupDir() {
    try {
        await fs.access(BACKUP_DIR);
    } catch {
        await fs.mkdir(BACKUP_DIR, { recursive: true });
    }
}

async function getFileSize(filePath) {
    const stats = await fs.stat(filePath);
    return stats.size;
}


async function createDatabaseBackup() {
    await ensureBackupDir();

    const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .slice(0, -5);

    const filename =
        `${character.firstname.toLowerCase()}_backup_${timestamp}.sql`;

    const filepath = path.join(BACKUP_DIR, filename);

    const pool = getPool();
    const connection = await pool.getConnection();

    try {
        const chunks = [];

        chunks.push('-- MariaDB SQL Backup\n');
        chunks.push(`-- Database: ${process.env.DB_NAME}\n\n`);
        chunks.push('SET FOREIGN_KEY_CHECKS=0;\n\n');

        const [tables] = await connection.query('SHOW FULL TABLES');

        for (const row of tables) {
            const tableName = row[Object.keys(row)[0]];
            const tableType = row[Object.keys(row)[1]];

            // Views are skipped by this basic backup implementation.
            if (tableType === 'VIEW') {
                continue;
            }

            const escapedTable = connection.escapeId(tableName);

            const [createResult] = await connection.query(
                `SHOW CREATE TABLE ${escapedTable}`
            );

            const createKey = Object.keys(createResult[0])
                .find(key => key.toLowerCase().includes('create'));

            if (!createKey) {
                throw new Error(
                    `Could not get table structure for ${tableName}`
                );
            }

            chunks.push(`-- Table: ${tableName}\n`);
            chunks.push(`DROP TABLE IF EXISTS ${escapedTable};\n`);
            chunks.push(`${createResult[0][createKey]};\n\n`);

            const [rows] = await connection.query(
                `SELECT * FROM ${escapedTable}`
            );

            if (rows.length === 0) {
                continue;
            }

            const columns = Object.keys(rows[0])
                .map(column => connection.escapeId(column))
                .join(', ');

            chunks.push(
                `INSERT INTO ${escapedTable} (${columns}) VALUES\n`
            );

            const values = rows.map(row => {
                const escapedValues = Object.values(row)
                    .map(value => connection.escape(value))
                    .join(', ');

                return `(${escapedValues})`;
            });

            chunks.push(values.join(',\n'));
            chunks.push(';\n\n');
        }

        chunks.push('SET FOREIGN_KEY_CHECKS=1;\n');

        await fs.writeFile(filepath, chunks.join(''), 'utf8');

        const fileSize = await getFileSize(filepath);

        return {
            filepath,
            fileSize,
            filename
        };
    } catch (error) {
        try {
            await fs.unlink(filepath);
        } catch {}

        throw new Error(
            `Backup failed: ${error.message}`
        );
    } finally {
        connection.release();
    }
}
async function compressBackup(sqlFilePath) {
    const gzipPath = `${sqlFilePath}.gz`;

    await pipeline(
        createReadStream(sqlFilePath),
        createGzip(),
        createWriteStream(gzipPath)
    );

    const compressedSize = await getFileSize(gzipPath);

    await fs.unlink(sqlFilePath);

    return {
        filepath: gzipPath,
        fileSize: compressedSize
    };
}

async function cleanOldBackups() {
    try {
        const files = await fs.readdir(BACKUP_DIR);
        const now = Date.now();
        const maxAge = 7 * 24 * 60 * 60 * 1000;
        
        for (const file of files) {
            const filePath = path.join(BACKUP_DIR, file);
            const stats = await fs.stat(filePath);
            
            if (now - stats.mtimeMs > maxAge) {
                await fs.unlink(filePath);
            }
        }
    } catch (error) {
        console.error('[backup:cleanOldBackups] Error cleaning old backups:', error.message);
    }
}



export function scheduleAutoBackup() {
    cron.schedule('0 */4 * * *', async () => {
        console.log('[backup:scheduleAutoBackup] Starting scheduled backup...');
        
        const backupChannel = await db.getBackupChannel();
        
        if (!backupChannel) {
            console.log('[backup:scheduleAutoBackup] No backup channel configured.');
            return;
        }

        try {
            const bot = global.bot;
            if (!bot) {
                console.error('[backup:scheduleAutoBackup] Bot instance not available.');
                return;
            }

            const statusMsg = await bot.sendMessage(
                backupChannel.channel_id,
                '⏳ **در حال تهیه بکاپ خودکار...**\n\nلطفاً صبر کنید، این کار ممکن است چند دقیقه طول بکشد.',
                { parse_mode: 'Markdown' }
            );

            let backupFilepath = null;

            try {
                let backup = await createDatabaseBackup();
                backupFilepath = backup.filepath;

                backup = await compressBackup(backup.filepath);
                backupFilepath = backup.filepath;

                if (backup.fileSize > MAX_TELEGRAM_FILE_SIZE) {
                    await bot.editMessageText(
                        `❌ بکاپ خودکار ناموفق: حجم فایل بیش از حد مجاز (${formatFileSize(backup.fileSize)})`,
                        {
                            chat_id: backupChannel.channel_id,
                            message_id: statusMsg.message_id
                        }
                    );
                    return;
                }

                const jalaliDate = new Date().toLocaleDateString('fa-IR');
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
                        caption: caption,
                        parse_mode: 'Markdown'
                    }
                );

                await bot.deleteMessage(
                    backupChannel.channel_id,
                    statusMsg.message_id
                ).catch(() => {});
                
                console.log('[backup:scheduleAutoBackup] Backup sent successfully.');

            } catch (error) {
                console.error(
                    '[backup:scheduleAutoBackup] Error:',
                    error.message
                );

                await bot.editMessageText(
                    `❌ **خطا در تهیه بکاپ خودکار**\n\n*مشکل:* ${error.message || 'خطایی ناشناخته'}`,
                    {
                        chat_id: backupChannel.channel_id,
                        message_id: statusMsg.message_id,
                        parse_mode: 'Markdown'
                    }
                ).catch(() => {});
            } finally {
                if (backupFilepath) {
                    try {
                        await fs.unlink(backupFilepath);
                    } catch (e) {
                        console.error(
                            `[backup:scheduleAutoBackup] Failed to delete: ${e.message}`
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
    }, {
        scheduled: true,
        timezone: "UTC"
    });

    console.log('[backup:scheduleAutoBackup] Scheduled every 4 hours.');
}

export async function sendCriticalAlert(message) {
    try {
        const bot = global.bot;
        if (!bot) return;
        
        const backupChannel = await db.getBackupChannel();
        if (!backupChannel) return;
        
        const alertText =
            `🚨 **هشدار بحرانی**\n\n${message}\n\n⏰ زمان: ${new Date().toLocaleString('fa-IR')}`;
        
        await bot.sendMessage(
            backupChannel.channel_id,
            alertText,
            { parse_mode: 'Markdown' }
        );
    } catch (error) {
        console.error(
            '[backup:sendCriticalAlert] Failed to send alert:',
            error.message
        );
    }
}
    
    const statusMsg =
        await sendMessageSafe(
            bot, 
            msg.chat.id,
            '⏳ **در حال تهیه پشتیبان از دیتابیس...**\n\nلطفاً صبر کنید، این کار ممکن است چند دقیقه طول بکشد.',
            {
                reply_to_message_id: msg.message_id
            }
        );
    
    let backupFilepath = null;
    
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
                `لطفاً از mysqldump مستقیم استفاده کنید.`;
                
            await editMessageSafe(
                bot, 
                msg.chat.id,
                statusMsg.message_id,
                errorText
            );
            
            await fs.unlink(
                backupFilepath
            );

            backupFilepath = null;

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
                caption: caption,
                parse_mode: 'Markdown'
            }
        );
        
        await bot.deleteMessage(
            msg.chat.id,
            statusMsg.message_id
        ).catch(() => {});
        
    } catch (error) {
        console.error(
            '❌ [backup:handleBackupCommand] CRITICAL ERROR:',
            error.originalError || error
        );
        
        const errorMessage =
            `❌ **خطا در تهیه پشتیبان**\n\n` +
            `*مشکل:* ${error.message || 'خطای ناشناخته'}\n\n` +
            `اطمینان حاصل کنید که mysqldump روی سرور نصب شده و دسترسی شبکه دارد.`;
        
        await editMessageSafe(
            bot, 
            msg.chat.id,
            statusMsg.message_id,
            errorMessage
        ).catch(() => {
            bot.sendMessage(
                msg.chat.id,
                errorMessage
            ).catch(() => {});
        });
        
    } finally {
        if (backupFilepath) {
            try {
                await fs.unlink(
                    backupFilepath
                );
            } catch (e) {
                console.error(
                    `[backup:handleBackupCommand] Failed to delete temporary file ${backupFilepath}:`,
                    e.message
                );
            }
        }

        await cleanOldBackups();
    }
}