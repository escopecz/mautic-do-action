/**
 * Process management utilities
 */

import type { ProcessResult, ProcessOptions } from './types.ts';

export class ProcessManager {
  static async run(cmd: string[], options: ProcessOptions = {}): Promise<ProcessResult> {
    if (!cmd[0]) {
      throw new Error('Command cannot be empty');
    }
    
    try {
      const commandOptions: any = {
        args: cmd.slice(1),
        stdout: 'piped' as const,
        stderr: 'piped' as const,
      };
      
      if (options.cwd) {
        commandOptions.cwd = options.cwd;
      }
      
      const process = new Deno.Command(cmd[0], commandOptions);
      
      const { code, stdout, stderr } = await process.output();
      const output = new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);
      
      return {
        success: code === 0,
        output: output.trim(),
        exitCode: code
      };
    } catch (error: unknown) {
      if (options.ignoreError) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return { success: false, output: errorMessage, exitCode: -1 };
      }
      throw error;
    }
  }
  
  static async runShell(command: string, options: ProcessOptions = {}): Promise<ProcessResult> {
    return this.run(['bash', '-c', command], options);
  }
}