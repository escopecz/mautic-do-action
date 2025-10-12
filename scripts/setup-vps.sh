#!/bin/bash

set -e
export DEBIAN_FRONTEND=noninteractive

echo "🔄 Updating system packages..."
apt-get update

echo "🐳 Installing Docker..."
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