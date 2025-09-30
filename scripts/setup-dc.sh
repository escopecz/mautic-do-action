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

# Wait for apt locks to be released
echo "🔒 Checking for apt locks..."
timeout=300
counter=0
while sudo fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || sudo fuser /var/lib/apt/lists/lock >/dev/null 2>&1; do
    if [ $counter -ge $timeout ]; then
        echo "❌ Timeout waiting for apt locks to be released"
        echo "🔍 Current apt processes:"
        ps aux | grep -E "(apt|dpkg)" | grep -v grep || true
        exit 1
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
                    # Check for locks again
                    while sudo fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do
                        echo "⏳ Waiting for dpkg lock..."
                        sleep 5
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
mkdir -p /var/www/{mautic_data,mysql_data,logs}
cd /var/www

# Stop any existing containers
echo "🛑 Stopping any existing containers..."
if [ -f docker-compose.yml ]; then
    $DOCKER_COMPOSE_CMD down || true
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
$DOCKER_COMPOSE_CMD up -d

# Wait for services to be ready
echo "⏳ Waiting for services to start..."
sleep 30

# Wait for containers to be healthy
echo "🏥 Checking container health..."
container_timeout=180
container_counter=0
while ! docker ps --filter "name=mautic_app" --filter "status=running" --quiet | grep -q .; do
    if [ $container_counter -ge $container_timeout ]; then
        echo "❌ Mautic container failed to start properly"
        echo "📊 Container status:"
        $DOCKER_COMPOSE_CMD ps
        echo "📋 Container logs:"
        docker logs mautic_app --tail 50 2>/dev/null || echo "No logs available"
        exit 1
    fi
    echo "Waiting for Mautic container to be running... (${container_counter}/${container_timeout}s)"
    sleep 10
    container_counter=$((container_counter + 10))
done
echo "✅ Mautic container is running"

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

# Wait for Mautic files to be ready
echo "📁 Waiting for Mautic files to be initialized..."
mautic_timeout=300
mautic_counter=0
while ! docker exec mautic_app test -f /var/www/html/bin/console; do
    if [ $mautic_counter -ge $mautic_timeout ]; then
        echo "❌ Timeout waiting for Mautic files to be ready"
        echo "📋 Mautic container logs:"
        docker logs mautic_app --tail 30 2>/dev/null || echo "No logs available"
        echo "📁 Directory contents:"
        docker exec mautic_app ls -la /var/www/html/ 2>/dev/null || echo "Cannot access directory"
        exit 1
    fi
    
    # Show progress every 30 seconds
    if [ $((mautic_counter % 30)) -eq 0 ] && [ $mautic_counter -gt 0 ]; then
        echo "📊 File initialization progress:"
        echo "  - Container status: $(docker inspect --format='{{.State.Status}}' mautic_app 2>/dev/null || echo 'unknown')"
        echo "  - Directory contents:"
        docker exec mautic_app ls -la /var/www/html/ 2>/dev/null | head -10 || echo "    Cannot access directory"
        echo "  - Recent logs:"
        docker logs mautic_app --tail 3 --since 30s 2>/dev/null || echo "    No recent logs"
    fi
    
    echo "Waiting for Mautic files... (${mautic_counter}/${mautic_timeout}s)"
    sleep 10
    mautic_counter=$((mautic_counter + 10))
done
echo "✅ Mautic files are ready"

# Check if Mautic is already installed
echo "🔍 Checking if Mautic is already installed..."
if docker exec mautic_app test -f /var/www/html/config/local.php; then
    echo "✅ Mautic appears to be already configured"
    # Still run cache clear to ensure everything is fresh
    echo "🧹 Clearing Mautic cache..."
    docker exec -u www-data mautic_app php /var/www/html/bin/console cache:clear --no-interaction || echo "⚠️ Cache clear failed"
else
    # Install Mautic if not already installed
    echo "🔧 Installing Mautic..."
    docker exec -u www-data mautic_app php /var/www/html/bin/console mautic:install \
        --db_driver=pdo_mysql \
        --db_host=mysql \
        --db_port=3306 \
        --db_name="${MYSQL_DATABASE}" \
        --db_user="${MYSQL_USER}" \
        --db_password="${MYSQL_PASSWORD}" \
        --admin_email="${EMAIL_ADDRESS}" \
        --admin_password="${MAUTIC_PASSWORD}" \
        --admin_firstname="Admin" \
        --admin_lastname="User" \
        --force --no-interaction

    if [ $? -eq 0 ]; then
        echo "✅ Mautic installation completed"
    else
        echo "⚠️ Mautic installation may have failed, checking application status..."
    fi

    # Clear cache after installation
    echo "🧹 Clearing Mautic cache..."
    docker exec -u www-data mautic_app php /var/www/html/bin/console cache:clear --no-interaction || echo "⚠️ Cache clear failed"
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

# Check Mautic application
echo "🔍 Checking Mautic application..."
echo "📊 Container status:"
$DOCKER_COMPOSE_CMD ps

echo "📋 Checking Mautic logs for startup progress..."
docker logs mautic_app --tail 20 2>/dev/null || echo "⚠️ Unable to fetch Mautic logs"

timeout=600  # Increased to 10 minutes for Mautic initialization
counter=0
while true; do
    if [ $counter -ge $timeout ]; then
        echo "❌ Mautic application timeout after ${timeout} seconds"
        echo "🔍 Final diagnostics:"
        echo "📊 Container status:"
        $DOCKER_COMPOSE_CMD ps
        echo "📋 Mautic application logs (last 50 lines):"
        docker logs mautic_app --tail 50 2>/dev/null || echo "No logs available"
        echo "📋 MySQL logs (last 20 lines):"
        docker logs mautic_mysql --tail 20 2>/dev/null || echo "No logs available"
        echo "🌐 Network connectivity test:"
        curl -v "http://localhost:${PORT}" || true
        exit 1
    fi
    
    # Check HTTP response
    http_code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${PORT}" 2>/dev/null || echo "000")
    
    # Accept 200 (success) or 302 (redirect to login) as success
    if [ "$http_code" = "200" ] || [ "$http_code" = "302" ]; then
        echo "✅ Mautic is ready (HTTP ${http_code})"
        break
    fi
    
    # Show progress and diagnostics every 60 seconds
    if [ $((counter % 60)) -eq 0 ] && [ $counter -gt 0 ]; then
        echo "📊 Progress update at ${counter}s:"
        echo "  - Container status:"
        $DOCKER_COMPOSE_CMD ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"
        echo "  - Recent Mautic logs:"
        docker logs mautic_app --tail 5 --since 60s 2>/dev/null || echo "    No recent logs"
        echo "  - HTTP response test:"
        echo "    HTTP Status: ${http_code}, Response time: $(curl -s -o /dev/null -w "%{time_total}s" "http://localhost:${PORT}" 2>/dev/null || echo 'N/A')"
    fi
    
    echo "Waiting for Mautic... (${counter}/${timeout}s) [HTTP: ${http_code}]"
    sleep 10
    counter=$((counter + 10))
done

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
echo "  View logs: $DOCKER_COMPOSE_CMD logs -f"
echo "  Restart services: $DOCKER_COMPOSE_CMD restart"
echo "  Stop services: $DOCKER_COMPOSE_CMD down"
echo "  Update Mautic: Change MAUTIC_VERSION in .mautic_env and run $DOCKER_COMPOSE_CMD up -d"

echo "Setup completed at: $(date)"