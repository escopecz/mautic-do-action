# Mautic DigitalOcean Deploy Action

A GitHub Action to automatically deploy Mautic (open-source marketing automation) to DigitalOcean with zero configuration.

## ✨ Features

- 🚀 **One-click deployment** - Deploy Mautic in minutes, not hours
- 🖥️ **Automatic VPS creation** - Creates and configures DigitalOcean droplets
- 🔒 **SSL/HTTPS support** - Automatic Let's Encrypt SSL certificates (when domain provided)
- 🐳 **Docker-based** - Reliable, containerized deployment with Apache
- 📧 **Email ready** - Pre-configured for email marketing campaigns
- 🎨 **Custom themes/plugins** - Support for custom Mautic extensions
- ⚙️ **Cron jobs** - Automated background tasks for optimal performance
- 📊 **Monitoring ready** - Built-in logging and health checks

## 🚀 Quick Start

### 1. Prerequisites

- DigitalOcean account with API token
- SSH key pair for server access
- Domain name (optional, can use IP address)

### 2. Setup Secrets

Add these secrets to your GitHub repository (`Settings` → `Secrets and variables` → `Actions`):

```
DIGITALOCEAN_TOKEN=your_do_api_token
SSH_PRIVATE_KEY=your_ssh_private_key
SSH_FINGERPRINT=your_ssh_key_fingerprint
MAUTIC_PASSWORD=your_admin_password
MYSQL_PASSWORD=your_mysql_password
MYSQL_ROOT_PASSWORD=your_mysql_root_password
```

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
          ssh-fingerprint: ${{ secrets.SSH_FINGERPRINT }}
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
| `ssh-fingerprint` | SSH key fingerprint | `${{ secrets.SSH_FINGERPRINT }}` |

### Optional

| Parameter | Description | Default | Example |
|-----------|-------------|---------|---------|
| `vps-size` | DigitalOcean droplet size | `s-2vcpu-2gb` | `s-4vcpu-8gb` |
| `vps-region` | DigitalOcean region | `nyc1` | `fra1`, `lon1`, `sgp1` |
| `domain` | Custom domain name | _(uses IP)_ | `mautic.example.com` |
| `mautic-version` | Mautic Docker image version | `6.0.5-apache` | `6.0.4-apache` |
| `mautic-port` | Port for Mautic application | `8001` | `8080` |
| `themes` | Packagist theme packages (newline-separated) | _(none)_ | `vendor/theme-name:^1.0` |
| `plugins` | Packagist plugin packages (newline-separated) | _(none)_ | `vendor/plugin-name:^2.0` |
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
    themes: |
      vendor/custom-theme:^1.0
      another-vendor/modern-theme:^2.0
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

**1. SSH Connection Failed**
```
Error: Permission denied (publickey)
```
- Verify your SSH private key is correctly formatted in secrets
- Ensure the SSH fingerprint matches your DigitalOcean SSH key

**2. Domain Not Pointing to Server**
```
Error: Domain example.com does not point to VPS IP
```
- Update your DNS A record to point to the VPS IP
- Wait for DNS propagation (can take up to 24 hours)

**3. SSL Certificate Failed**
```
Error: SSL certificate installation failed
```
- Ensure domain is pointing to the server before deployment
- Check that port 80 and 443 are not blocked

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

The deployment includes:

- Docker health checks
- Automatic log rotation
- Cron job monitoring
- MySQL performance optimization
- nginx caching and compression

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