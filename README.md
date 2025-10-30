# Mautic DigitalOcean Deploy Action

A GitHub Action to automatically deploy Mautic (open-source marketing automation) to DigitalOcean with zero configuration.

## ✨ Features

- 🚀 **One-click deployment** - Deploy Mautic in minutes, not hours
- 🖥️ **Automatic VPS creation** - Creates and configures DigitalOcean droplets
- 🔒 **SSL/HTTPS support** - Automatic Let's Encrypt SSL certificates (when domain provided)
- 🐳 **Docker-based** - Reliable, containerized deployment with Apache
- 📧 **Email ready** - Pre-configured for email marketing campaigns
- 🎨 **Custom themes/plugins** - Support for custom Mautic extensions via Composer or direct GitHub/ZIP installation
- 🏗️ **Custom Docker Images** - Automatically builds custom images with your plugins pre-installed (build-time approach)
- ⚙️ **Cron jobs** - Automated background tasks for optimal performance
- 📊 **Basic monitoring** - DigitalOcean monitoring, container logging, and deployment artifacts

## 🚀 Quick Start

### 1. Prerequisites

- DigitalOcean account with API token (see required permissions below)
- SSH key pair for server access (uploaded to your DigitalOcean account)
- Domain name (optional, can use IP address)

#### DigitalOcean API Token Requirements

Your DigitalOcean API token must have the following permissions:

**Required Scopes:**
- `droplet:create` - Create new VPS instances
- `droplet:read` - Read droplet information  
- `droplet:delete` - Delete droplets (for cleanup)
- `ssh_key:read` - Access SSH keys for droplet creation
- `domain:read` - Read domain information (if using custom domain)
- `domain:write` - Manage DNS records (if using custom domain)

**How to create a token:**
1. Go to DigitalOcean Control Panel → API → Personal Access Tokens
2. Click "Generate New Token"
3. Set name (e.g., "GitHub Mautic Deploy")
4. Select "Full Access" or manually select the scopes listed above
5. Copy the token immediately (you won't see it again)

### 2. Setup Secrets

Add these secrets to your GitHub repository (`Settings` → `Secrets and variables` → `Actions`):

```
DIGITALOCEAN_TOKEN=your_do_api_token
SSH_PRIVATE_KEY=your_ssh_private_key
MAUTIC_PASSWORD=your_admin_password
MYSQL_PASSWORD=your_mysql_password
MYSQL_ROOT_PASSWORD=your_mysql_root_password
```

#### SSH Key Setup Guide

**🔐 Recommended: Generate a Dedicated SSH Key for Automation**

For security, create a new SSH key specifically for this GitHub Action:

```bash
# Generate a new SSH key (without passphrase for automation)
ssh-keygen -t ed25519 -f ~/.ssh/mautic_deploy_key -N "" -C "mautic-github-action"

# Add the public key to your DigitalOcean account
cat ~/.ssh/mautic_deploy_key.pub
# Copy this output and add it in DigitalOcean Control Panel → Settings → Security → SSH Keys
```

**SSH_PRIVATE_KEY**: The content of your **dedicated** private SSH key
- Use the new key: `cat ~/.ssh/mautic_deploy_key`
- Copy the entire file content including `-----BEGIN OPENSSH PRIVATE KEY-----` and `-----END OPENSSH PRIVATE KEY-----`
- ⚠️ **Key must have NO passphrase** for automation


**Security Benefits:**
- 🔒 Separate key limits blast radius if compromised
- 🚫 Can be easily revoked without affecting other services
- 📝 Clear audit trail for automation access
- 🔄 Can be rotated independently

Make sure your SSH public key is already added to your DigitalOcean account before running the action.

### 3. Create Workflow

Create `.github/workflows/deploy-mautic.yml`:

```yaml
name: Deploy Mautic

on:
  workflow_dispatch:
    inputs:
      vps_name:
        description: 'VPS Name'
        required: true
        default: 'mautic-server'

jobs:
  deploy:
    runs-on: ubuntu-latest
    
    steps:
      - name: Deploy Mautic
        uses: escopecz/mautic-deploy-action@v1
        with:
          vps-name: ${{ inputs.vps_name }}
          vps-size: 's-2vcpu-2gb'
          vps-region: 'nyc1'
          domain: 'mautic.yourdomain.com'
          email: 'admin@yourdomain.com'
          mautic-password: ${{ secrets.MAUTIC_PASSWORD }}
          mysql-password: ${{ secrets.MYSQL_PASSWORD }}
          mysql-root-password: ${{ secrets.MYSQL_ROOT_PASSWORD }}
          do-token: ${{ secrets.DIGITALOCEAN_TOKEN }}
          ssh-private-key: ${{ secrets.SSH_PRIVATE_KEY }}
```

### 4. Deploy

1. Go to your repository's `Actions` tab
2. Select "Deploy Mautic" workflow
3. Click "Run workflow"
4. Enter your VPS name and click "Run workflow"

## 📋 Input Parameters

### Required

| Parameter | Description | Example |
|-----------|-------------|---------|
| `vps-name` | Name for the DigitalOcean droplet | `mautic-production` |
| `email` | Admin email address | `admin@example.com` |
| `mautic-password` | Admin password (use secrets!) | `${{ secrets.MAUTIC_PASSWORD }}` |
| `mysql-password` | MySQL user password | `${{ secrets.MYSQL_PASSWORD }}` |
| `mysql-root-password` | MySQL root password | `${{ secrets.MYSQL_ROOT_PASSWORD }}` |
| `do-token` | DigitalOcean API token | `${{ secrets.DIGITALOCEAN_TOKEN }}` |
| `ssh-private-key` | SSH private key for server access | `${{ secrets.SSH_PRIVATE_KEY }}` |

### Optional

| Parameter | Description | Default | Example |
|-----------|-------------|---------|---------|
| `vps-size` | DigitalOcean droplet size | `s-2vcpu-2gb` | `s-4vcpu-8gb` |
| `vps-region` | DigitalOcean region | `nyc1` | `fra1`, `lon1`, `sgp1` |
| `domain` | Custom domain name | _(uses IP)_ | `mautic.example.com` |
| `mautic-version` | Mautic Docker image version | `6.0.5-apache` | `6.0.4-apache` |
| `mautic-port` | Port for Mautic application | `8001` | `8080` |
| `themes` | Custom themes from GitHub/ZIP URLs (comma-separated) | _(none)_ | `https://github.com/user/theme/archive/main.zip` |
| `plugins` | Custom plugins from GitHub/ZIP URLs (comma-separated) | _(none)_ | `https://github.com/user/plugin/archive/main.zip` |
| `mysql-database` | MySQL database name | `mautic` | `mautic_prod` |
| `mysql-user` | MySQL username | `mautic` | `mautic_user` |

## 📤 Outputs

| Output | Description |
|--------|-------------|
| `vps-ip` | IP address of the created VPS |
| `mautic-url` | Full URL to access Mautic |
| `deployment-log` | Path to deployment log file |

## 📁 Examples

### Basic Deployment
```yaml
- uses: escopecz/mautic-deploy-action@v1
  with:
    vps-name: 'my-mautic'
    email: 'admin@example.com'
    # ... other required parameters
```

### Advanced with Custom Domain and SSL
```yaml
- uses: escopecz/mautic-deploy-action@v1
  with:
    vps-name: 'mautic-production'
    vps-size: 's-4vcpu-8gb'
    domain: 'marketing.example.com'
    email: 'admin@example.com'
    # ... other parameters
```

### With Custom Plugins from GitHub
```yaml
- uses: escopecz/mautic-deploy-action@v1
  with:
    vps-name: 'mautic-with-plugins'
    email: 'admin@example.com'
    plugins: |
      https://github.com/youruser/StripeBundle/archive/refs/heads/6.x.zip,
      https://github.com/company/AnalyticsPlugin/archive/refs/tags/v1.2.0.zip
    themes: |
      https://github.com/youruser/CustomTheme/archive/refs/heads/main.zip
    # ... other parameters
```

### Multiple Environments
```yaml
- uses: escopecz/mautic-deploy-action@v1
  with:
    vps-name: 'mautic-${{ github.event.inputs.environment }}'
    domain: '${{ github.event.inputs.environment }}.mautic.example.com'
    # ... other parameters
```

## 🔧 Advanced Configuration

### Custom Themes and Plugins

You can install custom themes and plugins from Packagist using Composer packages:

```yaml
themes: |
  vendor/custom-theme:^1.0
  another-vendor/modern-theme:dev-main

plugins: |
  vendor/analytics-plugin:^2.0
  vendor/social-plugin:^1.5
```

The action will use `composer require` to install these packages into your Mautic instance.

### Custom Plugins from GitHub/ZIP Files (Build-Time Installation)

**🎯 Recommended Approach** - For custom plugins hosted on GitHub or as ZIP files, the action can build a custom Docker image with your plugins pre-installed:

```yaml
- uses: escopecz/mautic-deploy-action@v1
  with:
    vps-name: 'mautic-custom'
    email: 'admin@example.com'
    # Custom plugins (comma-separated URLs)
    plugins: |
      https://github.com/youruser/StripeBundle/archive/refs/heads/6.x.zip,
      https://github.com/company/CustomCRM/archive/refs/tags/v2.1.0.zip
    
    # Custom themes (comma-separated URLs)  
    themes: |
      https://github.com/youruser/CustomTheme/archive/refs/heads/main.zip
    # ... other required parameters
```

**Supported URL Formats:**
- **GitHub Archives**: `https://github.com/user/repo/archive/refs/heads/main.zip`
- **Tagged Releases**: `https://github.com/user/repo/archive/refs/tags/v1.0.0.zip`
- **Direct ZIP Files**: `https://example.com/plugin.zip`

**Advantages:**
- ✅ **Faster Startup**: Plugins pre-installed during image build
- ✅ **More Reliable**: No network dependencies at runtime  
- ✅ **Official Pattern**: Follows Mautic Docker team's recommended approach
- ✅ **Zero Complexity**: No SSH keys or runtime installation needed

**📖 Full Documentation**: [Custom Plugins Deployment Guide](examples/custom-plugins-deployment.md)

### Database Configuration

Customize database settings:

```yaml
mysql-database: 'mautic_production'
mysql-user: 'mautic_admin'
mysql-password: ${{ secrets.MYSQL_PASSWORD }}
mysql-root-password: ${{ secrets.MYSQL_ROOT_PASSWORD }}
```

### VPS Sizing Guidelines

| Size | vCPUs | RAM | Use Case |
|------|-------|-----|----------|
| `s-1vcpu-1gb` | 1 | 1GB | Testing/Development |
| `s-2vcpu-2gb` | 2 | 2GB | Small campaigns (<10k contacts) |
| `s-2vcpu-4gb` | 2 | 4GB | Medium campaigns (10k-50k contacts) |
| `s-4vcpu-8gb` | 4 | 8GB | Large campaigns (50k+ contacts) |

## 🛠️ Troubleshooting

### Common Issues

**1. DigitalOcean API Permission Error**
```
Error: You are missing the required permission ssh_key:read
```
- Your DigitalOcean API token doesn't have sufficient permissions
- Generate a new token with "Full Access" or ensure it includes: `droplet:create`, `droplet:read`, `droplet:delete`, `ssh_key:read`, `domain:read`, `domain:write`
- Update your `DIGITALOCEAN_TOKEN` secret with the new token

**2. SSH Connection Failed**
```
Error: Permission denied (publickey)
```
- **Most Common Cause**: SSH private key doesn't match any key in your DigitalOcean account
  - Ensure your SSH public key is added to DigitalOcean: Settings → Security → SSH Keys
  - The action automatically generates the fingerprint and finds the matching key
- Verify your SSH private key is correctly formatted in secrets (include the full key with headers)
- Make sure your SSH public key is added to your DigitalOcean account **before** running the action
- Use an SSH key without a passphrase for automation
- Check the action logs for debugging information about key verification

**3. Domain Not Pointing to Server**
```
Error: Domain example.com does not point to VPS IP
```
- Update your DNS A record to point to the VPS IP
- Wait for DNS propagation (can take up to 24 hours)

**4. SSL Certificate Failed**
```
Error: SSL certificate installation failed
```
- Ensure domain is pointing to the server before deployment
- Check that port 80 and 443 are not blocked

### SSH Key Troubleshooting Guide

If you're getting `Permission denied (publickey)` errors, follow these steps:

**1. Verify Your SSH Key**
```bash
# Generate fingerprint from your dedicated private key
ssh-keygen -l -f ~/.ssh/mautic_deploy_key

# View your public key (to add to DigitalOcean if missing)
cat ~/.ssh/mautic_deploy_key.pub
```

**2. Check DigitalOcean SSH Keys**
```bash
# List all SSH keys in your DO account
doctl compute ssh-key list

# Find the fingerprint that matches your key
```

**3. Verify Key Format in GitHub Secrets**
- `SSH_PRIVATE_KEY`: Must include headers and be the full private key:
  ```
  -----BEGIN OPENSSH PRIVATE KEY-----
  b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAlwAAAAdzc2gtcn
  ... (rest of key content) ...
  -----END OPENSSH PRIVATE KEY-----
  ```
- The action automatically finds the matching key in your DigitalOcean account

**4. Test SSH Connection Manually**
```bash
ssh -i ~/.ssh/mautic_deploy_key root@YOUR_VPS_IP
```

### Getting Help

1. Check the deployment log artifact uploaded after each run
2. SSH into your server: `ssh root@YOUR_VPS_IP`
3. View Docker logs: `docker-compose logs -f`
4. Check Mautic logs: `tail -f /var/www/logs/*.log`

## 🔒 Security

- Uses DigitalOcean's private networking
- Automatic SSL/TLS encryption with Let's Encrypt
- Database passwords are securely managed
- Regular security updates via official Docker images
- SSH key-based authentication only

## 📊 Monitoring

The deployment includes basic monitoring:

- DigitalOcean VPS monitoring (CPU, RAM, disk usage)
- Docker container status monitoring
- Application logs captured in `/var/www/logs`
- Deployment log artifacts uploaded to GitHub Actions
- Automated Mautic cron jobs for maintenance tasks

**Note**: For production environments, consider adding:
- Docker health checks in docker-compose.yml
- Log rotation with logrotate
- External monitoring (Uptime Robot, Pingdom, etc.)
- Application performance monitoring (APM)
- Database performance monitoring

## 🔄 Maintenance

### Updating Mautic

To update Mautic to a new version:

1. Change the `mautic-version` parameter
2. Re-run the workflow
3. The action will pull the new image and restart services

### Backup Strategy

Important directories to backup:
- `/var/www/mautic_data` - Mautic files and uploads
- `/var/www/mysql_data` - Database files

### Scaling

For high-traffic deployments:
- Use larger VPS sizes (`s-4vcpu-8gb` or higher)
- Consider dedicated database servers
- Implement Redis for session storage
- Use CDN for static assets

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [Mautic](https://mautic.org) - Open-source marketing automation
- [DigitalOcean](https://digitalocean.com) - Cloud infrastructure
- [Docker](https://docker.com) - Containerization platform