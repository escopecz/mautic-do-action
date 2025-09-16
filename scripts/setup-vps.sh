#!/bin/bash

set -e
export DEBIAN_FRONTEND=noninteractive

echo "🔄 Updating system packages..."
apt-get update

echo "🐳 Installing Docker..."
apt-get install -y docker.io docker-compose

echo "🔐 Starting Docker service..."
systemctl start docker
systemctl enable docker

echo "🧹 Cleaning up..."
apt-get autoremove -y
apt-get autoclean

echo "✅ VPS setup completed successfully"