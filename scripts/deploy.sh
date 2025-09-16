#!/bin/bash

set -e

echo "🚀 Starting Mautic deployment to DigitalOcean..."

# Set default port if not provided
MAUTIC_PORT=${INPUT_MAUTIC_PORT:-8001}

echo "📝 Configuration:"
echo "  VPS Name: ${INPUT_VPS_NAME}"
echo "  VPS Size: ${INPUT_VPS_SIZE}"
echo "  VPS Region: ${INPUT_VPS_REGION}"
echo "  Mautic Version: ${INPUT_MAUTIC_VERSION}"
echo "  Email: ${INPUT_EMAIL}"
echo "  Domain: ${INPUT_DOMAIN:-'Not set (will use IP)'}"
echo "  Themes: ${INPUT_THEMES:-'None'}"
echo "  Plugins: ${INPUT_PLUGINS:-'None'}"

# Create VPS if it doesn't exist
echo "🖥️  Checking if VPS '${INPUT_VPS_NAME}' exists..."
if ! doctl compute droplet list | grep -q "${INPUT_VPS_NAME}"; then
    echo "📦 Creating new VPS '${INPUT_VPS_NAME}'..."
    doctl compute droplet create "${INPUT_VPS_NAME}" \
        --image docker-20-04 \
        --size "${INPUT_VPS_SIZE}" \
        --region "${INPUT_VPS_REGION}" \
        --ssh-keys "${INPUT_SSH_FINGERPRINT}" \
        --wait \
        --user-data-file "${ACTION_PATH}/scripts/setup-vps.sh" \
        --enable-monitoring
    echo "✅ VPS created successfully"
else
    echo "✅ VPS '${INPUT_VPS_NAME}' already exists"
fi

# Get VPS IP
echo "🔍 Getting VPS IP address..."
while : ; do
    STATUS=$(doctl compute droplet get "${INPUT_VPS_NAME}" --format Status --no-header)
    if [ "$STATUS" = "active" ]; then
        VPS_IP=$(doctl compute droplet get "${INPUT_VPS_NAME}" --format PublicIPv4 --no-header)
        if [ -n "$VPS_IP" ]; then
            echo "✅ VPS is active. IP address: $VPS_IP"
            break
        fi
    fi
    echo "⏳ Waiting for VPS to be ready..."
    sleep 5
done

# Wait for SSH to be available
echo "🔐 Waiting for SSH to be available..."
while ! nc -z "$VPS_IP" 22; do
    echo "⏳ Waiting for SSH..."
    sleep 5
done
echo "✅ SSH is available"

# Verify domain points to VPS (if domain is provided)
if [ -n "$INPUT_DOMAIN" ]; then
    echo "🌐 Verifying domain configuration..."
    DOMAIN_IP=$(dig +short "$INPUT_DOMAIN")
    if [ "$DOMAIN_IP" != "$VPS_IP" ]; then
        echo "❌ Error: Domain $INPUT_DOMAIN does not point to VPS IP $VPS_IP"
        echo "Current domain IP: $DOMAIN_IP"
        echo "Please update your DNS A record to point to: $VPS_IP"
        exit 1
    fi
    echo "✅ Domain correctly points to VPS"
fi

# Prepare nginx configuration (if domain is provided)
if [ -n "$INPUT_DOMAIN" ]; then
    echo "🔧 Preparing nginx configuration..."
    cp "${ACTION_PATH}/templates/nginx-virtual-host-template" "nginx-virtual-host-${INPUT_DOMAIN}"
    sed -i "s/DOMAIN_NAME/${INPUT_DOMAIN}/g" "nginx-virtual-host-${INPUT_DOMAIN}"
    sed -i "s/PORT/${MAUTIC_PORT}/g" "nginx-virtual-host-${INPUT_DOMAIN}"
fi

# Create deployment environment file
echo "📋 Creating deployment configuration..."
cp "${ACTION_PATH}/templates/.env.template" deploy.env

# Add all configuration to deploy.env
cat >> deploy.env << EOF
# Deployment Configuration
EMAIL_ADDRESS=${INPUT_EMAIL}
MAUTIC_PASSWORD=${INPUT_MAUTIC_PASSWORD}
IP_ADDRESS=${VPS_IP}
PORT=${MAUTIC_PORT}
MAUTIC_VERSION=${INPUT_MAUTIC_VERSION}
MAUTIC_THEMES=${INPUT_THEMES}
MAUTIC_PLUGINS=${INPUT_PLUGINS}
MYSQL_DATABASE=${INPUT_MYSQL_DATABASE}
MYSQL_USER=${INPUT_MYSQL_USER}
MYSQL_PASSWORD=${INPUT_MYSQL_PASSWORD}
MYSQL_ROOT_PASSWORD=${INPUT_MYSQL_ROOT_PASSWORD}
EOF

if [ -n "$INPUT_DOMAIN" ]; then
    echo "DOMAIN_NAME=${INPUT_DOMAIN}" >> deploy.env
fi

# Copy templates to current directory for deployment
cp "${ACTION_PATH}/templates/docker-compose.yml" .
cp "${ACTION_PATH}/scripts/setup-dc.sh" .
cp "${ACTION_PATH}/templates/.mautic_env" .

echo "📁 Files prepared for deployment:"
ls -la deploy.env docker-compose.yml setup-dc.sh .mautic_env

# Deploy to server
echo "🚀 Deploying to server..."
mkdir -p ~/.ssh
echo "$INPUT_SSH_PRIVATE_KEY" > ~/.ssh/id_rsa
chmod 600 ~/.ssh/id_rsa

# Copy files to server
echo "📤 Copying files to server..."
scp -o StrictHostKeyChecking=no -i ~/.ssh/id_rsa -r . root@${VPS_IP}:/var/www/

# Run setup script
echo "⚙️  Running setup script on server..."
ssh -o StrictHostKeyChecking=no -i ~/.ssh/id_rsa root@${VPS_IP} "cd /var/www && chmod +x setup-dc.sh && ./setup-dc.sh > /var/log/setup-dc.log 2>&1"

# Download setup log
echo "📥 Downloading setup log..."
scp -o StrictHostKeyChecking=no -i ~/.ssh/id_rsa root@${VPS_IP}:/var/log/setup-dc.log ./setup-dc.log

# Clean up SSH key
rm -f ~/.ssh/id_rsa

# Set outputs
if [ -n "$INPUT_DOMAIN" ]; then
    MAUTIC_URL="https://${INPUT_DOMAIN}"
else
    MAUTIC_URL="http://${VPS_IP}:${MAUTIC_PORT}"
fi

echo "vps-ip=${VPS_IP}" >> $GITHUB_OUTPUT
echo "mautic-url=${MAUTIC_URL}" >> $GITHUB_OUTPUT
echo "deployment-log=./setup-dc.log" >> $GITHUB_OUTPUT

echo "🎉 Deployment completed successfully!"
echo "🌐 Your Mautic instance is available at: ${MAUTIC_URL}"
echo "📧 Admin email: ${INPUT_EMAIL}"
echo "📊 Check the deployment log artifact for detailed information"