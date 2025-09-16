#!/bin/bash

set -e

# Enhanced error handling and logging
exec > >(tee -a /var/log/setup-dc.log)
exec 2>&1

echo "🚀 Starting Mautic Docker Compose setup..."
echo "Timestamp: $(date)"

# Source environment variables
if [ -f deploy.env ]; then
    echo "📋 Loading deployment configuration..."
    set -a
    source deploy.env
    set +a
else
    echo "❌ Error: deploy.env file not found"
    exit 1
fi

# Verify required variables
required_vars=("EMAIL_ADDRESS" "MAUTIC_PASSWORD" "IP_ADDRESS" "PORT" "MAUTIC_VERSION" "MYSQL_DATABASE" "MYSQL_USER" "MYSQL_PASSWORD" "MYSQL_ROOT_PASSWORD")
for var in "${required_vars[@]}"; do
    if [ -z "${!var}" ]; then
        echo "❌ Error: Required variable $var is not set"
        exit 1
    fi
done

echo "✅ Configuration validated"

# Install system dependencies
echo "📦 Installing system dependencies..."
export DEBIAN_FRONTEND=noninteractive
apt-get update

# Install required packages
packages=("curl" "wget" "unzip" "git" "nano" "htop" "cron" "netcat")
if [ -n "$DOMAIN_NAME" ]; then
    packages+=("nginx" "certbot" "python3-certbot-nginx")
fi

for package in "${packages[@]}"; do
    if ! dpkg -l | grep -q "^ii  $package "; then
        echo "Installing $package..."
        apt-get install -y "$package"
    else
        echo "$package is already installed"
    fi
done

# Install Docker if not present
if ! command -v docker &> /dev/null; then
    echo "🐳 Installing Docker..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sh get-docker.sh
    rm get-docker.sh
else
    echo "✅ Docker is already installed"
fi

# Install Docker Compose if not present
if ! command -v docker-compose &> /dev/null; then
    echo "📦 Installing Docker Compose..."
    curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    chmod +x /usr/local/bin/docker-compose
else
    echo "✅ Docker Compose is already installed"
fi

# Start Docker service
systemctl start docker
systemctl enable docker

# Create directory structure
echo "📁 Creating directory structure..."
mkdir -p /var/www/{mautic_data,mysql_data,logs}
cd /var/www

# Stop any existing containers
echo "🛑 Stopping any existing containers..."
if [ -f docker-compose.yml ]; then
    docker-compose down || true
fi

# Create Mautic environment file
echo "⚙️  Creating Mautic environment file..."
cat > .mautic_env << EOF
# Mautic Configuration
MAUTIC_DB_HOST=mysql
MAUTIC_DB_USER=${MYSQL_USER}
MAUTIC_DB_PASSWORD=${MYSQL_PASSWORD}
MAUTIC_DB_NAME=${MYSQL_DATABASE}
MAUTIC_ADMIN_EMAIL=${EMAIL_ADDRESS}
MAUTIC_ADMIN_PASSWORD=${MAUTIC_PASSWORD}
MAUTIC_ADMIN_FIRSTNAME=Admin
MAUTIC_ADMIN_LASTNAME=User
MAUTIC_TRUSTED_PROXIES=0.0.0.0/0
MAUTIC_VERSION=${MAUTIC_VERSION}
EOF

# Create MySQL environment file
echo "🗄️  Creating MySQL environment file..."
cat > .mysql_env << EOF
MYSQL_ROOT_PASSWORD=${MYSQL_ROOT_PASSWORD}
MYSQL_DATABASE=${MYSQL_DATABASE}
MYSQL_USER=${MYSQL_USER}
MYSQL_PASSWORD=${MYSQL_PASSWORD}
EOF

# Setup cron job
echo "⏰ Setting up cron jobs..."
mkdir -p cron
cat > cron/mautic << 'EOF'
# Mautic cron jobs
*/2 * * * * docker exec -u www-data $(docker ps --filter "name=mautic_app" --format "{{.Names}}" | head -1) php /var/www/html/bin/console mautic:segments:update --batch-limit=900 --max-contacts=300 >/dev/null 2>&1
*/5 * * * * docker exec -u www-data $(docker ps --filter "name=mautic_app" --format "{{.Names}}" | head -1) php /var/www/html/bin/console mautic:campaigns:update --batch-limit=100 >/dev/null 2>&1
*/10 * * * * docker exec -u www-data $(docker ps --filter "name=mautic_app" --format "{{.Names}}" | head -1) php /var/www/html/bin/console mautic:campaigns:trigger --batch-limit=100 >/dev/null 2>&1
*/10 * * * * docker exec -u www-data $(docker ps --filter "name=mautic_app" --format "{{.Names}}" | head -1) php /var/www/html/bin/console mautic:emails:send --message-limit=100 >/dev/null 2>&1
*/15 * * * * docker exec -u www-data $(docker ps --filter "name=mautic_app" --format "{{.Names}}" | head -1) php /var/www/html/bin/console mautic:broadcasts:send --batch=100 >/dev/null 2>&1
0 2 * * * docker exec -u www-data $(docker ps --filter "name=mautic_app" --format "{{.Names}}" | head -1) php /var/www/html/bin/console mautic:maintenance:cleanup --days-old=365 --dry-run >/dev/null 2>&1
0 3 * * * docker exec -u www-data $(docker ps --filter "name=mautic_app" --format "{{.Names}}" | head -1) php /var/www/html/bin/console mautic:import --limit=500 >/dev/null 2>&1
0 4 * * * docker exec -u www-data $(docker ps --filter "name=mautic_app" --format "{{.Names}}" | head -1) php /var/www/html/bin/console mautic:import:process >/dev/null 2>&1
EOF

# Install cron jobs
crontab cron/mautic

# Start containers first
echo "🚀 Starting Docker containers..."
docker-compose up -d

# Wait for services to be ready
echo "⏳ Waiting for services to start..."
sleep 30

# Check MySQL connection
echo "🔍 Checking MySQL connection..."
timeout=120
counter=0
while ! docker exec mautic_mysql mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" -e "SELECT 1;" > /dev/null 2>&1; do
    if [ $counter -ge $timeout ]; then
        echo "❌ MySQL connection timeout"
        exit 1
    fi
    echo "Waiting for MySQL... ($counter/${timeout}s)"
    sleep 5
    counter=$((counter + 5))
done
echo "✅ MySQL is ready"

# Install themes if specified
if [ -n "$MAUTIC_THEMES" ] && [ "$MAUTIC_THEMES" != "None" ]; then
    echo "🎨 Installing Mautic themes via Composer..."
    while IFS= read -r theme; do
        theme=$(echo "$theme" | xargs) # Trim whitespace
        if [ -n "$theme" ]; then
            echo "Installing theme: $theme"
            docker exec -u www-data mautic_app composer require "$theme" --no-interaction --optimize-autoloader || echo "⚠️ Failed to install theme: $theme"
        fi
    done <<< "$MAUTIC_THEMES"
fi

# Install plugins if specified
if [ -n "$MAUTIC_PLUGINS" ] && [ "$MAUTIC_PLUGINS" != "None" ]; then
    echo "🔌 Installing Mautic plugins via Composer..."
    while IFS= read -r plugin; do
        plugin=$(echo "$plugin" | xargs) # Trim whitespace
        if [ -n "$plugin" ]; then
            echo "Installing plugin: $plugin"
            docker exec -u www-data mautic_app composer require "$plugin" --no-interaction --optimize-autoloader || echo "⚠️ Failed to install plugin: $plugin"
        fi
    done <<< "$MAUTIC_PLUGINS"
fi

# Clear Mautic cache after installing packages
if [ -n "$MAUTIC_THEMES" ] || [ -n "$MAUTIC_PLUGINS" ]; then
    echo "🧹 Clearing Mautic cache..."
    docker exec -u www-data mautic_app php /var/www/html/bin/console cache:clear --no-interaction || echo "⚠️ Cache clear failed"
fi

# Check Mautic application
echo "🔍 Checking Mautic application..."
timeout=300
counter=0
while ! curl -f "http://localhost:${PORT}" > /dev/null 2>&1; do
    if [ $counter -ge $timeout ]; then
        echo "❌ Mautic application timeout"
        exit 1
    fi
    echo "Waiting for Mautic... ($counter/${timeout}s)"
    sleep 10
    counter=$((counter + 10))
done
echo "✅ Mautic is ready"

# Setup SSL if domain is provided
if [ -n "$DOMAIN_NAME" ]; then
    echo "🔒 Setting up SSL with Let's Encrypt..."
    
    # Install certbot
    apt-get install -y certbot python3-certbot-nginx
    
    # Create nginx configuration
    if [ -f "nginx-virtual-host-${DOMAIN_NAME}" ]; then
        cp "nginx-virtual-host-${DOMAIN_NAME}" "/etc/nginx/sites-available/${DOMAIN_NAME}"
        ln -sf "/etc/nginx/sites-available/${DOMAIN_NAME}" "/etc/nginx/sites-enabled/"
        rm -f /etc/nginx/sites-enabled/default
        nginx -t && systemctl reload nginx
        
        # Get SSL certificate
        certbot --nginx -d "$DOMAIN_NAME" --non-interactive --agree-tos --email "$EMAIL_ADDRESS"
        
        echo "✅ SSL certificate installed for $DOMAIN_NAME"
    else
        echo "⚠️  Warning: nginx configuration file not found, skipping SSL setup"
    fi
fi

# Set correct permissions
echo "🔐 Setting permissions..."
chown -R www-data:www-data /var/www/mautic_data
chmod -R 755 /var/www/mautic_data

# Display final status
echo ""
echo "🎉 Mautic setup completed successfully!"
echo "====================================="
echo "📊 Service Status:"
docker-compose ps

echo ""
echo "🌐 Access Information:"
if [ -n "$DOMAIN_NAME" ]; then
    echo "  URL: https://${DOMAIN_NAME}"
else
    echo "  URL: http://${IP_ADDRESS}:${PORT}"
fi
echo "  Admin Email: ${EMAIL_ADDRESS}"
echo "  Admin Password: ${MAUTIC_PASSWORD}"

echo ""
echo "📁 Data Locations:"
echo "  Mautic Data: /var/www/mautic_data"
echo "  MySQL Data: /var/www/mysql_data"
echo "  Logs: /var/www/logs"

echo ""
echo "⚙️  Management Commands:"
echo "  View logs: docker-compose logs -f"
echo "  Restart services: docker-compose restart"
echo "  Stop services: docker-compose down"
echo "  Update Mautic: Change MAUTIC_VERSION in .mautic_env and run docker-compose up -d"

echo "Setup completed at: $(date)"