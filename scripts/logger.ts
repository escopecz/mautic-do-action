/**
 * Logger utility for Mautic deployment
 */

export class Logger {
  private static logFile = '/var/log/setup-dc.log';
  
  static async init() {
    try {
      await Deno.writeTextFile(this.logFile, '');
      await Deno.chmod(this.logFile, 0o600);
    } catch (error: unknown) {
      console.error('Failed to initialize log file:', error);
    }
  }
  
  static log(message: string, emoji = '📋') {
    const timestamp = new Date().toISOString();
    const logMessage = `${emoji} ${message}`;
    console.log(logMessage);
    
    // Also write to log file
    try {
      Deno.writeTextFileSync(this.logFile, `[${timestamp}] ${logMessage}\n`, { append: true });
    } catch {
      // Ignore log file errors
    }
  }
  
  static error(message: string) {
    this.log(message, '❌');
  }
  
  static success(message: string) {
    this.log(message, '✅');
  }
  
  static info(message: string) {
    this.log(message, 'ℹ️');
  }
  
  static warning(message: string) {
    this.log(message, '⚠️');
  }
}