/**
 * Docker container management
 */

import type { ContainerInfo } from './types.ts';
import { Logger } from './logger.ts';
import { ProcessManager } from './process-manager.ts';

export class DockerManager {
  static async isDockerRunning(): Promise<boolean> {
    const result = await ProcessManager.runShell('docker info', { ignoreError: true });
    return result.success;
  }
  
  static async getContainerInfo(containerName: string): Promise<ContainerInfo | null> {
    const result = await ProcessManager.runShell(
      `docker inspect ${containerName} --format '{{.Name}},{{.Config.Image}},{{.State.Status}},{{.State.Health.Status}}' 2>/dev/null || echo "not_found"`,
      { ignoreError: true }
    );
    
    if (!result.success || result.output === 'not_found') {
      return null;
    }
    
    const [name, image, status, health] = result.output.split(',');
    return {
      name: (name || '').replace('/', ''),
      image: image || '',
      status: status || '',
      health: health && health !== '<no value>' ? health : undefined
    };
  }
  
  static async listMauticContainers(): Promise<ContainerInfo[]> {
    const containers = ['mautic_web', 'mautic_db', 'mautic_cron'];
    const results: ContainerInfo[] = [];
    
    for (const container of containers) {
      const info = await this.getContainerInfo(container);
      if (info) {
        results.push(info);
      }
    }
    
    return results;
  }
  
  static async getCurrentMauticVersion(): Promise<string | null> {
    const webContainer = await this.getContainerInfo('mautic_web');
    if (!webContainer) {
      return null;
    }
    
    // Extract version from image tag
    const imageTag = webContainer.image.split(':')[1];
    return imageTag || null;
  }
  
  static async pullImage(image: string): Promise<boolean> {
    Logger.log(`Pulling Docker image: ${image}`, '🐳');
    const result = await ProcessManager.runShell(`docker pull ${image}`, { ignoreError: true });
    
    if (result.success) {
      Logger.success(`Successfully pulled ${image}`);
      return true;
    } else {
      Logger.error(`Failed to pull ${image}: ${result.output}`);
      return false;
    }
  }
  
  static async recreateContainers(): Promise<boolean> {
    Logger.log('Recreating Docker containers...', '🔄');
    
    try {
      // Stop containers gracefully
      await ProcessManager.runShell('docker compose down', { ignoreError: true });
      
      // Remove any stopped containers
      await ProcessManager.runShell('docker compose rm -f', { ignoreError: true });
      
      // Start containers
      const result = await ProcessManager.runShell('docker compose up -d', { ignoreError: true });
      
      if (result.success) {
        Logger.success('Containers recreated successfully');
        return true;
      } else {
        Logger.error(`Failed to recreate containers: ${result.output}`);
        return false;
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      Logger.error(`Error recreating containers: ${errorMessage}`);
      return false;
    }
  }
  
  static async waitForHealthy(containerName: string, timeoutSeconds = 300): Promise<boolean> {
    Logger.log(`Waiting for ${containerName} to be healthy...`, '🏥');
    
    for (let i = 0; i < timeoutSeconds; i += 15) {
      const info = await this.getContainerInfo(containerName);
      
      if (info?.status === 'running') {
        if (!info.health || info.health === 'healthy') {
          Logger.success(`${containerName} is healthy`);
          return true;
        }
      }
      
      // Show detailed status every 30 seconds for MySQL debugging
      if (containerName === 'mautic_db' && (i % 30 === 0 || i >= timeoutSeconds - 15)) {
        Logger.log(`${containerName} status: ${info?.status || 'unknown'}, health: ${info?.health || 'unknown'}`, '⏳');
        
        // Get MySQL container logs for debugging
        const logs = await ProcessManager.runShell(`docker logs ${containerName} --tail 15`, { ignoreError: true });
        if (logs.success && logs.output) {
          Logger.log(`${containerName} recent logs:\n${logs.output}`, '📋');
        }
        
        // Check if MySQL process is running inside container
        const processCheck = await ProcessManager.runShell(`docker exec ${containerName} ps aux | grep mysql || echo "No MySQL process found"`, { ignoreError: true });
        if (processCheck.success) {
          Logger.log(`${containerName} processes: ${processCheck.output}`, '🔍');
        }
        
        // Check MySQL data directory
        const dataCheck = await ProcessManager.runShell(`docker exec ${containerName} ls -la /var/lib/mysql/ | head -10 || echo "Cannot access MySQL data"`, { ignoreError: true });
        if (dataCheck.success) {
          Logger.log(`${containerName} data directory: ${dataCheck.output}`, '�');
        }
      } else {
        Logger.log(`${containerName} status: ${info?.status || 'unknown'}, health: ${info?.health || 'unknown'}`, '⏳');
      }
      
      await new Promise(resolve => setTimeout(resolve, 15000));
    }
    
    Logger.error(`Timeout waiting for ${containerName} to be healthy`);
    return false;
  }
}