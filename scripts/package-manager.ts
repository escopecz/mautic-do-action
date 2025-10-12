/**
 * Package management with apt lock handling
 */

import { Logger } from './logger.ts';
import { ProcessManager } from './process-manager.ts';

export class PackageManager {
  private static readonly LOCK_FILES = [
    '/var/lib/dpkg/lock-frontend',
    '/var/lib/apt/lists/lock',
    '/var/cache/apt/archives/lock',
    '/var/lib/dpkg/lock'
  ];
  
  static async checkAptLocks(): Promise<boolean> {
    let locksHeld = false;
    
    // Check lock files
    for (const lockFile of this.LOCK_FILES) {
      const result = await ProcessManager.runShell(`fuser ${lockFile}`, { ignoreError: true });
      if (result.success) {
        Logger.warning(`${lockFile} is held`);
        locksHeld = true;
      }
    }
    
    // Check for running processes
    const processCheck = await ProcessManager.runShell(
      'pgrep -f "apt-get|apt|dpkg|unattended-upgrade"', 
      { ignoreError: true }
    );
    if (processCheck.success) {
      Logger.warning('apt/dpkg processes are running');
      locksHeld = true;
    }
    
    return locksHeld;
  }
  
  static async waitForLocks(timeoutSeconds = 600): Promise<void> {
    Logger.log('Checking for apt locks...', '🔒');
    
    let counter = 0;
    
    while (await this.checkAptLocks()) {
      if (counter >= timeoutSeconds) {
        Logger.error(`Timeout waiting for apt locks after ${timeoutSeconds} seconds`);
        Logger.log('Forcing lock release...', '🚨');
        
        // Kill processes
        await ProcessManager.runShell('pkill -9 -f "apt-get|apt|dpkg|unattended-upgrade"', { ignoreError: true });
        
        // Remove lock files
        for (const lockFile of this.LOCK_FILES) {
          await ProcessManager.runShell(`rm -f ${lockFile}`, { ignoreError: true });
        }
        
        // Fix broken packages
        await ProcessManager.runShell('dpkg --configure -a', { ignoreError: true });
        await new Promise(resolve => setTimeout(resolve, 5000));
        break;
      }
      
      // Show detailed info every 60 seconds
      if (counter % 60 === 0 && counter > 0) {
        Logger.log('Analyzing lock status...', '🔍');
        const processes = await ProcessManager.runShell('ps aux | grep -E "(apt|dpkg|unattended)" | grep -v grep', { ignoreError: true });
        if (processes.output) {
          Logger.log(`Running processes:\n${processes.output}`);
        }
        
        // Try to stop unattended upgrades
        await ProcessManager.runShell('systemctl stop unattended-upgrades', { ignoreError: true });
        await ProcessManager.runShell('pkill -f unattended-upgrade', { ignoreError: true });
      }
      
      Logger.log(`Waiting for apt locks... (${counter}/${timeoutSeconds}s)`, '⏳');
      await new Promise(resolve => setTimeout(resolve, 15000));
      counter += 15;
    }
    
    Logger.success('Apt locks released');
  }
  
  static async updatePackages(): Promise<void> {
    Logger.log('Updating package lists...', '📦');
    
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await ProcessManager.runShell('apt-get update', { ignoreError: true });
      if (result.success) {
        Logger.success('Package lists updated successfully');
        return;
      }
      
      if (attempt < 3) {
        Logger.warning(`apt-get update failed (attempt ${attempt}/3), retrying in 30 seconds...`);
        await new Promise(resolve => setTimeout(resolve, 30000));
      } else {
        throw new Error('Failed to update package lists after 3 attempts');
      }
    }
  }
  
  static async installPackage(packageName: string): Promise<void> {
    // Check if already installed
    const checkInstalled = await ProcessManager.runShell(
      `dpkg -l | grep -q "^ii  ${packageName} "`, 
      { ignoreError: true }
    );
    
    if (checkInstalled.success) {
      Logger.success(`${packageName} is already installed`);
      return;
    }
    
    Logger.log(`Installing ${packageName}...`, '📦');
    
    for (let attempt = 1; attempt <= 3; attempt++) {
      // Wait for locks before installation
      await this.waitForLocks(120);
      
      const result = await ProcessManager.runShell(
        `DEBIAN_FRONTEND=noninteractive apt-get install -y -o Dpkg::Lock::Timeout=60 ${packageName}`,
        { ignoreError: true }
      );
      
      if (result.success) {
        Logger.success(`${packageName} installed successfully`);
        return;
      }
      
      if (attempt < 3) {
        Logger.warning(`Failed to install ${packageName} (attempt ${attempt}/3)`);
        await new Promise(resolve => setTimeout(resolve, 30000));
      } else {
        // Final attempt with force
        Logger.log(`Final attempt with force options for ${packageName}...`, '🚨');
        const forceResult = await ProcessManager.runShell(
          `DEBIAN_FRONTEND=noninteractive apt-get install -y --fix-broken ${packageName}`,
          { ignoreError: true }
        );
        
        if (forceResult.success) {
          Logger.success(`${packageName} installed with force`);
          return;
        } else {
          throw new Error(`Complete failure installing ${packageName}`);
        }
      }
    }
  }
}