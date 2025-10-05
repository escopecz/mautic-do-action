#!/bin/bash

set -e

# Enhanced error handling and logging
touch /var/log/setup-dc.log
chmod 600 /var/log/setup-dc.log  # Restrict log file access
exec > >(tee -a /var/log/setup-dc.log)
exec 2>&1

echo "🚀 Starting Mautic Docker Compose setup..."
echo "Timestamp: $(date)"
echo "🔍 Environment check:"
echo "  - Current user: $(whoami)"
echo "  - Current directory: $(pwd)"
echo "  - Available commands: docker=$(command -v docker || echo 'NOT FOUND'), curl=$(command -v curl || echo 'NOT FOUND')"
echo "  - Docker version: $(docker --version 2>/dev/null || echo 'Docker not available')"

# Source environment variables
if [ -f deploy.env ]; then
    echo "📋 Loading deployment configuration..."
    echo "📁 deploy.env file found ($(wc -l < deploy.env) lines) - contents hidden for security"
    echo "---"
    
    # Validate deploy.env format before sourcing
    if grep -E '^[[:space:]]*[a-zA-Z_][a-zA-Z0-9_]*=[^=]*$|^[[:space:]]*#|^[[:space:]]*$' deploy.env > /dev/null; then
        set -a
        source deploy.env
        set +a
        echo "✅ Configuration loaded successfully"
    else
        echo "❌ Error: deploy.env contains invalid format"
        echo "📋 Invalid lines:"
        grep -vE '^[[:space:]]*[a-zA-Z_][a-zA-Z0-9_]*=[^=]*$|^[[:space:]]*#|^[[:space:]]*$' deploy.env || true
        exit 1
    fi
else
    echo "❌ Error: deploy.env file not found"
    echo "📁 Current directory contents:"
    ls -la
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

# Proactively stop unattended-upgrades to prevent lock conflicts
echo "🛑 Stopping unattended-upgrades to prevent lock conflicts..."
systemctl stop unattended-upgrades || true
systemctl disable unattended-upgrades || true
pkill -f unattended-upgrade || true

# Wait for apt locks to be released
echo "🔒 Checking for apt locks..."
timeout=300
counter=0
while sudo fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || sudo fuser /var/lib/apt/lists/lock >/dev/null 2>&1; do
    if [ $counter -ge $timeout ]; then
        echo "❌ Timeout waiting for apt locks to be released"
        echo "🔍 Current apt processes:"
        ps aux | grep -E "(apt|dpkg|unattended)" | grep -v grep || true
        echo "⚠️ Attempting to stop unattended-upgrades and remove locks..."
        pkill -f unattended-upgrade || true
        systemctl stop unattended-upgrades || true
        sleep 5
        rm -f /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/cache/apt/archives/lock || true
        dpkg --configure -a || true
        break
    fi
    
    # Show more detailed info every 60 seconds
    if [ $((counter % 60)) -eq 0 ] && [ $counter -gt 0 ]; then
        echo "🔍 Checking what's holding the lock:"
        ps aux | grep -E "(apt|dpkg|unattended)" | grep -v grep || echo "No apt/dpkg processes found"
        lsof /var/lib/dpkg/lock-frontend 2>/dev/null || echo "No processes using lock file"
    fi
    
    echo "⏳ Waiting for apt locks to be released... ($counter/${timeout}s)"
    sleep 10
    counter=$((counter + 10))
done

echo "✅ Apt locks released, proceeding with package installation"
apt-get update

# Install required packages
packages=("curl" "wget" "unzip" "git" "nano" "htop" "cron" "netcat")
if [ -n "$DOMAIN_NAME" ]; then
    packages+=("nginx" "certbot" "python3-certbot-nginx")
fi

for package in "${packages[@]}"; do
    if ! dpkg -l | grep -q "^ii  $package "; then
        echo "Installing $package..."
        retry_count=0
        max_retries=3
        while [ $retry_count -lt $max_retries ]; do
            if apt-get install -y "$package"; then
                echo "✅ $package installed successfully"
                break
            else
                retry_count=$((retry_count + 1))
                if [ $retry_count -lt $max_retries ]; then
                    echo "⚠️ Failed to install $package (attempt $retry_count/$max_retries), retrying in 10 seconds..."
                    sleep 10
                    # Check for locks again with timeout and aggressive handling
                    lock_wait_counter=0
                    max_lock_wait=120  # 2 minutes
                    while sudo fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do
                        if [ $lock_wait_counter -ge $max_lock_wait ]; then
                            echo "⚠️ dpkg lock held too long, attempting to stop unattended-upgrades..."
                            # Kill unattended-upgrades if it's running
                            pkill -f unattended-upgrade || true
                            systemctl stop unattended-upgrades || true
                            sleep 10
                            # Force remove lock if still present
                            if sudo fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; then
                                echo "⚠️ Forcefully removing dpkg locks..."
                                rm -f /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/cache/apt/archives/lock || true
                                dpkg --configure -a || true
                            fi
                            break
                        fi
                        echo "⏳ Waiting for dpkg lock... (${lock_wait_counter}/${max_lock_wait}s)"
                        sleep 5
                        lock_wait_counter=$((lock_wait_counter + 5))
                    done
                else
                    echo "❌ Failed to install $package after $max_retries attempts"
                    exit 1
                fi
            fi
        done
    else
        echo "✅ $package is already installed"
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
if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
    echo "📦 Installing Docker Compose..."
    curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    chmod +x /usr/local/bin/docker-compose
    echo "✅ Docker Compose installed"
else
    if command -v docker-compose &> /dev/null; then
        echo "✅ Docker Compose (legacy) is already installed"
        DOCKER_COMPOSE_CMD="docker-compose"
    else
        echo "✅ Docker Compose (plugin) is already installed"
        DOCKER_COMPOSE_CMD="docker compose"
    fi
fi

# Determine which docker-compose command to use
if [ -z "$DOCKER_COMPOSE_CMD" ]; then
    if command -v docker-compose &> /dev/null; then
        DOCKER_COMPOSE_CMD="docker-compose"
    elif docker compose version &> /dev/null; then
        DOCKER_COMPOSE_CMD="docker compose"
    else
        echo "❌ Error: Docker Compose not available"
        exit 1
    fi
fi

echo "🐳 Using Docker Compose command: $DOCKER_COMPOSE_CMD"

# Start Docker service
systemctl start docker
systemctl enable docker

# Create directory structure
echo "📁 Creating directory structure..."
mkdir -p /var/www/logs
cd /var/www

# Stop any existing containers
echo "🛑 Stopping any existing containers..."
if [ -f docker-compose.yml ]; then
    $DOCKER_COMPOSE_CMD down || true
fi

# Create Mautic environment file from template (following official example pattern)
echo "🗄️  Creating Mautic environment file from template..."

if [ -f ".mautic_env.template" ]; then
    # Process template file and replace placeholders
    sed -e "s/MYSQL_DATABASE_PLACEHOLDER/${MYSQL_DATABASE}/g" \
        -e "s/MYSQL_USER_PLACEHOLDER/${MYSQL_USER}/g" \
        -e "s/MYSQL_PASSWORD_PLACEHOLDER/${MYSQL_PASSWORD}/g" \
        -e "s/EMAIL_ADDRESS_PLACEHOLDER/${EMAIL_ADDRESS}/g" \
        -e "s/MAUTIC_PASSWORD_PLACEHOLDER/${MAUTIC_PASSWORD}/g" \
        ".mautic_env.template" > ".mautic_env"
    
    echo "✅ .mautic_env file created from template"
else
    # Fallback: create .mautic_env directly if template not found
    echo "⚠️ Template not found, creating .mautic_env directly..."
    cat > .mautic_env << EOF
# Database Configuration
MAUTIC_DB_HOST=mysql
MAUTIC_DB_PORT=3306
MAUTIC_DB_DATABASE=${MYSQL_DATABASE}
MAUTIC_DB_USER=${MYSQL_USER}
MAUTIC_DB_PASSWORD=${MYSQL_PASSWORD}

# Admin User Configuration
MAUTIC_ADMIN_EMAIL=${EMAIL_ADDRESS}
MAUTIC_ADMIN_PASSWORD=${MAUTIC_PASSWORD}
MAUTIC_ADMIN_FIRSTNAME=Admin
MAUTIC_ADMIN_LASTNAME=User

# Mautic Configuration
MAUTIC_TRUSTED_PROXIES=["0.0.0.0/0"]
MAUTIC_RUN_CRON_JOBS=true

# Installation Configuration
MAUTIC_DB_PREFIX=
MAUTIC_INSTALL_FORCE=true
EOF
fi

# Secure the .mautic_env file
chmod 600 .mautic_env

# Create main environment file for Docker Compose
echo "🗄️  Creating Docker Compose environment file..."
cat > .env << EOF
# MySQL Configuration
MYSQL_ROOT_PASSWORD=${MYSQL_ROOT_PASSWORD}
MYSQL_DATABASE=${MYSQL_DATABASE}
MYSQL_USER=${MYSQL_USER}
MYSQL_PASSWORD=${MYSQL_PASSWORD}

# Mautic Configuration
MAUTIC_VERSION=${MAUTIC_VERSION}
PORT=${PORT}
EOF

# Validate environment files after both are created
echo "🔍 Validating environment configuration..."
if [ ! -f ".mautic_env" ]; then
    echo "❌ Error: .mautic_env file not found"
    exit 1
fi

if [ ! -f ".env" ]; then
    echo "❌ Error: .env file not found"
    exit 1
fi

echo "📋 Environment files present:"
echo "  - .env ($(wc -l < .env) lines)"
echo "  - .mautic_env ($(wc -l < .mautic_env) lines)"

# Verify required variables in .mautic_env
required_vars=("MAUTIC_DB_HOST" "MAUTIC_DB_DATABASE" "MAUTIC_DB_USER" "MAUTIC_ADMIN_EMAIL")
for var in "${required_vars[@]}"; do
    if ! grep -q "^${var}=" .mautic_env; then
        echo "❌ Error: Required variable $var not found in .mautic_env"
        exit 1
    fi
done
echo "✅ Environment validation completed"

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

# Start containers and wait for them to be healthy (excluding worker initially)
echo "🚀 Starting Docker containers with health checks..."
if ! $DOCKER_COMPOSE_CMD up -d db mautic; then
    echo "❌ Failed to start containers"
    echo "📊 Docker Compose status:"
    $DOCKER_COMPOSE_CMD ps || true
    echo "📋 Docker logs:"
    docker logs --tail 10 $(docker ps -aq) 2>/dev/null || echo "No container logs available"
    exit 1
fi

echo "✅ Containers started successfully"
echo "📊 Container status:"
$DOCKER_COMPOSE_CMD ps

# Wait for MySQL to be healthy
echo "⏳ Waiting for MySQL to be healthy..."
timeout=180
counter=0
while [ "$(docker inspect --format='{{.State.Health.Status}}' mautic_mysql 2>/dev/null)" != "healthy" ]; do
    if [ $counter -ge $timeout ]; then
        echo "❌ MySQL health check timeout"
        echo "📊 Container status:"
        $DOCKER_COMPOSE_CMD ps
        echo "📋 MySQL logs:"
        docker logs mautic_mysql --tail 20 2>/dev/null || echo "No logs available"
        exit 1
    fi
    echo "Waiting for MySQL health check... (${counter}/${timeout}s)"
    sleep 5
    counter=$((counter + 5))
done
echo "✅ MySQL is healthy"

# Wait for Mautic to be healthy  
echo "⏳ Waiting for Mautic to be healthy..."
timeout=300
counter=0
while [ "$(docker inspect --format='{{.State.Health.Status}}' mautic_app 2>/dev/null)" != "healthy" ]; do
    if [ $counter -ge $timeout ]; then
        echo "❌ Mautic health check timeout"
        echo "📊 Container status:"
        $DOCKER_COMPOSE_CMD ps
        echo "📋 Mautic logs:"
        docker logs mautic_app --tail 30 2>/dev/null || echo "No logs available"
        exit 1
    fi
    
    # Show progress every 30 seconds
    if [ $((counter % 30)) -eq 0 ] && [ $counter -gt 0 ]; then
        echo "📊 Health check progress:"
        echo "  - MySQL: $(docker inspect --format='{{.State.Health.Status}}' mautic_mysql 2>/dev/null || echo 'unknown')"
        echo "  - Mautic: $(docker inspect --format='{{.State.Health.Status}}' mautic_app 2>/dev/null || echo 'unknown')"
        echo "  - Recent Mautic logs:"
        docker logs mautic_app --tail 3 --since 30s 2>/dev/null || echo "    No recent logs"
    fi
    
    echo "Waiting for Mautic health check... (${counter}/${timeout}s)"
    sleep 10
    counter=$((counter + 10))
done
echo "✅ Mautic is healthy"

# Check if Mautic is already installed
echo "🔍 Checking if Mautic is already installed..."
if docker exec mautic_app test -f /var/www/html/config/local.php && docker exec mautic_app grep -q "site_url" /var/www/html/config/local.php 2>/dev/null; then
    echo "✅ Mautic is already installed (config contains site_url)"
    
    # Try to clear cache, but don't fail deployment if it doesn't work
    echo "🧹 Clearing Mautic cache..."
    if docker exec -u www-data mautic_app php /var/www/html/bin/console cache:clear --no-interaction 2>/dev/null; then
        echo "✅ Cache cleared successfully"
    else
        echo "⚠️ Cache clear failed, but Mautic appears to be installed"
        echo "   This is usually not critical for a running Mautic instance"
    fi
else
    # Install Mautic if not already installed
    echo "🔧 Installing Mautic..."
    
    # Note: Worker container is not started during initial deployment due to profile configuration
    echo "ℹ️ Worker container will be started after successful installation..."
    
    # Remove any corrupted local.php file that might exist
    echo "🧹 Cleaning up any existing configuration files..."
    docker exec mautic_app rm -f /var/www/html/config/local.php || echo "No local.php to remove"
    
    # Restart Mautic container to regenerate configuration with proper environment variables
    echo "🔄 Restarting Mautic container to regenerate configuration..."
    $DOCKER_COMPOSE_CMD restart mautic
    
    # Wait for Mautic to be healthy again after restart
    echo "⏳ Waiting for Mautic to be healthy after restart..."
    timeout=120
    counter=0
    while [ "$(docker inspect --format='{{.State.Health.Status}}' mautic_app 2>/dev/null)" != "healthy" ]; do
        if [ $counter -ge $timeout ]; then
            echo "❌ Mautic health check timeout after restart"
            exit 1
        fi
        echo "Waiting for Mautic health check... (${counter}/${timeout}s)"
        sleep 5
        counter=$((counter + 5))
    done
    echo "✅ Mautic is healthy after restart"
    
    # Debug: Check environment variables in container
    echo "🔍 Environment variables for installation:"
    echo "  EMAIL_ADDRESS: ${EMAIL_ADDRESS}"
    echo "  IP_ADDRESS: ${IP_ADDRESS}"
    echo "  PORT: ${PORT}"
    echo "  MAUTIC_DB_HOST: $(docker exec mautic_app printenv MAUTIC_DB_HOST 2>/dev/null || echo 'not set')"
    echo "  MAUTIC_DB_USER: $(docker exec mautic_app printenv MAUTIC_DB_USER 2>/dev/null || echo 'not set')"
    echo "  MAUTIC_DB_DATABASE: $(docker exec mautic_app printenv MAUTIC_DB_DATABASE 2>/dev/null || echo 'not set')"
    echo "  MAUTIC_ADMIN_EMAIL: $(docker exec mautic_app printenv MAUTIC_ADMIN_EMAIL 2>/dev/null || echo 'not set')"
    echo "  DOCKER_MAUTIC_ROLE: $(docker exec mautic_app printenv DOCKER_MAUTIC_ROLE 2>/dev/null || echo 'not set')"
    
    # Install Mautic using the official installation command
    echo "🚀 Running mautic:install command..."
    if docker exec -u www-data mautic_app php /var/www/html/bin/console mautic:install \
        --force \
        --admin_email="${EMAIL_ADDRESS}" \
        --admin_password="${MAUTIC_PASSWORD}" \
        "http://${IP_ADDRESS}:${PORT}"; then
        
        echo "✅ Mautic installation completed"
        
        # Start worker container after successful installation
        echo "🔄 Starting worker container..."
        $DOCKER_COMPOSE_CMD --profile worker up -d mautic_worker || echo "⚠️ Failed to start worker container"
        
        # Clear cache after installation
        echo "🧹 Clearing Mautic cache..."
        docker exec -u www-data mautic_app php /var/www/html/bin/console cache:clear --no-interaction || echo "⚠️ Cache clear failed"
    else
        echo "❌ Mautic installation failed"
        echo "🔍 Debug: Checking if local.php was created during failed installation..."
        if docker exec mautic_app test -f /var/www/html/config/local.php; then
            echo "� local.php was created but installation failed. Contents:"
            docker exec mautic_app cat /var/www/html/config/local.php || echo "Cannot read local.php"
        else
            echo "� No local.php file found after failed installation"
        fi
        echo "📋 Recent Mautic logs:"
        docker logs mautic_app --tail 20 2>/dev/null || echo "No logs available"
        exit 1
    fi
fi

# Set proper permissions
echo "🔐 Setting Mautic permissions..."
docker exec mautic_app chown -R www-data:www-data /var/www/html
docker exec mautic_app chmod -R 755 /var/www/html

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

# Final HTTP verification
echo "🔍 Verifying Mautic HTTP response..."
http_code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${PORT}" 2>/dev/null || echo "000")

if [ "$http_code" = "200" ] || [ "$http_code" = "302" ]; then
    echo "✅ Mautic is responding correctly (HTTP ${http_code})"
    if [ "$http_code" = "302" ]; then
        echo "   → Mautic is redirecting to login page (normal behavior)"
    fi
else
    echo "⚠️ Unexpected HTTP response: ${http_code}"
    echo "📋 Recent Mautic logs:"
    docker logs mautic_app --tail 10 2>/dev/null || echo "No logs available"
fi

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
chown -R www-data:www-data /var/www/logs
chmod -R 755 /var/www/logs

# Display final status
echo ""
echo "🎉 Mautic setup completed successfully!"
echo "====================================="
echo "📊 Service Status:"
$DOCKER_COMPOSE_CMD ps

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
echo "  Mautic Data: Docker volume 'mautic_data'"
echo "  MySQL Data: Docker volume 'mysql_data'"
echo "  Logs: /var/www/logs"

echo ""
echo "⚙️  Management Commands:"
echo "  View logs: $DOCKER_COMPOSE_CMD logs -f"
echo "  Restart services: $DOCKER_COMPOSE_CMD restart"
echo "  Stop services: $DOCKER_COMPOSE_CMD down"
echo "  Update Mautic: Change MAUTIC_VERSION in .env and run $DOCKER_COMPOSE_CMD up -d"

echo "Setup completed at: $(date)"
echo "SETUP_COMPLETED" # Marker for deployment script

# Ensure successful exit
exit 0