#!/bin/bash

set -e
export DEBIAN_FRONTEND=noninteractive

echo "🔄 Updating system packages..."
apt-get update

echo "� Creating swap file for memory-intensive operations..."
# Create 2GB swap file to handle memory spikes during Mautic installation
if [ ! -f /swapfile ]; then
    echo "Creating 2GB swap file..."
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    
    # Make swap permanent
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
    
    # Optimize swap usage (reduce swappiness)
    echo 'vm.swappiness=10' >> /etc/sysctl.conf
    echo 'vm.vfs_cache_pressure=50' >> /etc/sysctl.conf
    
    # Apply immediately
    sysctl vm.swappiness=10
    sysctl vm.vfs_cache_pressure=50
    
    echo "✅ Swap file created and configured"
    free -h
else
    echo "Swap file already exists"
    free -h
fi

echo "� Configuring firewall..."
# Enable UFW and configure ports for HTTP/HTTPS traffic
ufw --force enable
ufw allow ssh
ufw allow 80
ufw allow 443
echo "✅ Firewall configured (SSH, HTTP, HTTPS allowed)"

echo "🌐 Installing Nginx and SSL tools..."
apt-get install -y nginx certbot python3-certbot-nginx

echo "� Installing additional utilities..."
apt-get install -y curl wget unzip git nano htop cron netcat vim

echo "�🔐 Starting and enabling Nginx..."
systemctl start nginx
systemctl enable nginx

# Ensure nginx directories exist for SSL configuration
mkdir -p /etc/nginx/sites-available
mkdir -p /etc/nginx/sites-enabled

# Remove default site if it exists to avoid conflicts
rm -f /etc/nginx/sites-enabled/default

echo "� Installing Docker..."
apt-get install -y docker.io docker-compose-plugin

echo "🔐 Starting Docker service..."
systemctl start docker
systemctl enable docker

echo "🔧 Configuring SSH..."
# Ensure SSH is properly configured and started
systemctl enable ssh
systemctl start ssh

# Configure SSH to allow root login (required for the action)
sed -i 's/#PermitRootLogin yes/PermitRootLogin yes/' /etc/ssh/sshd_config
sed -i 's/PermitRootLogin no/PermitRootLogin yes/' /etc/ssh/sshd_config
systemctl restart ssh

echo "📁 Creating deployment directories..."
# Create the deployment directory structure
mkdir -p /var/www
mkdir -p /var/log
chown -R root:root /var/www
chmod 755 /var/www

echo "🧹 Cleaning up..."
apt-get autoremove -y
apt-get autoclean

echo "✅ VPS setup completed successfully"
echo "🔍 SSH service status: $(systemctl is-active ssh)"
echo "🔍 Docker service status: $(systemctl is-active docker)"
echo "🔍 Nginx service status: $(systemctl is-active nginx)"
echo "🔍 UFW firewall status: $(ufw status | head -1)"
echo "💾 Memory and swap status:"
free -h