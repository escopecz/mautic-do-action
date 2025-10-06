#!/bin/bash

set -e

echo "🚀 Starting# Find the SSH key ID in DigitalOcean by fingerprint
echo "🔍 Finding SSH key in DigitalOcean account..."
echo "Looking for fingerprint: ${SSH_FINGERPRINT}"

# Try to list SSH keys and find the matching one
SSH_KEY_LIST=$(doctl compute ssh-key list --format ID,FingerPrint --no-header 2>/dev/null || doctl compute ssh-key list --format ID,Fingerprint --no-header 2>/dev/null || echo "")

if [ -z "$SSH_KEY_LIST" ]; then
    echo "❌ Error: Failed to list SSH keys from DigitalOcean"
    exit 1
fi

SSH_KEY_ID=$(echo "$SSH_KEY_LIST" | grep "$SSH_FINGERPRINT" | awk '{print $1}')

if [ -z "$SSH_KEY_ID" ]; then
    echo "❌ Error: SSH key not found in DigitalOcean account"
    echo "Available SSH keys in your DigitalOcean account:"
    echo "$SSH_KEY_LIST"
    echo ""
    echo "Your generated fingerprint MD5: ${SSH_FINGERPRINT}"
    echo "Your generated fingerprint SHA256: $(ssh-keygen -l -f ~/.ssh/id_rsa.pub | awk '{print $2}')"
    echo ""
    echo "Please add your SSH public key to DigitalOcean first:"
    echo "Public Key:"
    cat ~/.ssh/id_rsa.pub
    echo ""
    echo "Go to: DigitalOcean Control Panel → Settings → Security → SSH Keys"
    exit 1
fiment to DigitalOcean..."

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

# Setup SSH configuration and generate fingerprint
echo "🔐 Setting up SSH authentication..."
mkdir -p ~/.ssh
echo "$INPUT_SSH_PRIVATE_KEY" > ~/.ssh/id_rsa
chmod 600 ~/.ssh/id_rsa

# Generate public key and fingerprint from private key
echo "🔑 Generating SSH fingerprint from private key..."
ssh-keygen -y -f ~/.ssh/id_rsa > ~/.ssh/id_rsa.pub

# Generate MD5 fingerprint (DigitalOcean format)
SSH_FINGERPRINT=$(ssh-keygen -l -f ~/.ssh/id_rsa.pub -E md5 | awk '{print $2}' | sed 's/MD5://')

if [ -z "$SSH_FINGERPRINT" ]; then
    echo "❌ Error: Failed to generate SSH fingerprint from private key"
    echo "Please verify your SSH private key is valid"
    exit 1
fi

echo "✅ SSH fingerprint generated MD5: ${SSH_FINGERPRINT}"

# Find the SSH key ID in DigitalOcean by fingerprint
echo "� Finding SSH key in DigitalOcean account..."
SSH_KEY_ID=$(doctl compute ssh-key list --format ID,FingerPrint --no-header | grep "$SSH_FINGERPRINT" | awk '{print $1}')

if [ -z "$SSH_KEY_ID" ]; then
    echo "❌ Error: SSH key not found in DigitalOcean account"
    echo "Please add your SSH public key to DigitalOcean first:"
    echo ""
    echo "Public Key:"
    cat ~/.ssh/id_rsa.pub
    echo ""
    echo "Go to: DigitalOcean Control Panel → Settings → Security → SSH Keys"
    exit 1
fi

echo "✅ Found SSH key in DigitalOcean (ID: ${SSH_KEY_ID})"

# Debug SSH key information
echo "🔍 SSH Key debugging info:"
echo "  - Private key file size: $(wc -c < ~/.ssh/id_rsa) bytes"
echo "  - Private key format: $(head -n 1 ~/.ssh/id_rsa | grep -o 'BEGIN.*KEY' || echo 'Unknown format')"
echo "  - Generated fingerprint MD5: ${SSH_FINGERPRINT}"
echo "  - Key file permissions: $(stat -c %a ~/.ssh/id_rsa 2>/dev/null || stat -f %A ~/.ssh/id_rsa)"

# Create VPS if it doesn't exist
echo "🖥️  Checking if VPS '${INPUT_VPS_NAME}' exists..."
if ! doctl compute droplet list | grep -q "${INPUT_VPS_NAME}"; then
    echo "📦 Creating new VPS '${INPUT_VPS_NAME}'..."
    echo "🔧 Using configured SSH key for access"
    
    # Verify user-data file exists
    if [ ! -f "${ACTION_PATH}/scripts/setup-vps.sh" ]; then
        echo "❌ Error: setup-vps.sh not found at ${ACTION_PATH}/scripts/setup-vps.sh"
        exit 1
    fi
    
    doctl compute droplet create "${INPUT_VPS_NAME}" \
        --image docker-20-04 \
        --size "${INPUT_VPS_SIZE}" \
        --region "${INPUT_VPS_REGION}" \
        --ssh-keys "${SSH_KEY_ID}" \
        --wait \
        --user-data-file "${ACTION_PATH}/scripts/setup-vps.sh" \
        --enable-monitoring
    
    echo "✅ VPS created successfully"
    echo "⏳ Allowing additional time for user-data script to complete..."
    sleep 30
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
SSH_TIMEOUT=300  # 5 minutes
SSH_COUNTER=0
while ! nc -z "$VPS_IP" 22; do
    if [ $SSH_COUNTER -ge $SSH_TIMEOUT ]; then
        echo "❌ SSH connection timeout after ${SSH_TIMEOUT} seconds"
        echo "🔍 VPS may still be starting up. Check DigitalOcean console."
        exit 1
    fi
    echo "⏳ Waiting for SSH... (${SSH_COUNTER}/${SSH_TIMEOUT}s)"
    sleep 10
    SSH_COUNTER=$((SSH_COUNTER + 10))
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

# Create clean deploy.env file
cat > deploy.env << EOF
# Environment variables for deployment
# Generated by GitHub Action

# Required Configuration
EMAIL_ADDRESS=${INPUT_EMAIL}
MAUTIC_PASSWORD=${INPUT_MAUTIC_PASSWORD}
IP_ADDRESS=${VPS_IP}
PORT=${MAUTIC_PORT}
MAUTIC_VERSION=${INPUT_MAUTIC_VERSION}

# Optional Configuration
MAUTIC_THEMES=${INPUT_THEMES}
MAUTIC_PLUGINS=${INPUT_PLUGINS}

# Database Configuration
MYSQL_DATABASE=${INPUT_MYSQL_DATABASE}
MYSQL_USER=${INPUT_MYSQL_USER}
MYSQL_PASSWORD=${INPUT_MYSQL_PASSWORD}
MYSQL_ROOT_PASSWORD=${INPUT_MYSQL_ROOT_PASSWORD}
EOF

if [ -n "$INPUT_DOMAIN" ]; then
    echo "DOMAIN_NAME=${INPUT_DOMAIN}" >> deploy.env
fi

# Secure the environment file
chmod 600 deploy.env
echo "🔒 Environment file secured with restricted permissions"

# Copy templates to current directory for deployment
cp "${ACTION_PATH}/templates/docker-compose.yml" .
cp "${ACTION_PATH}/scripts/setup-dc.sh" .
cp "${ACTION_PATH}/templates/.mautic_env.template" .

echo "📁 Files prepared for deployment:"
ls -la deploy.env docker-compose.yml setup-dc.sh .mautic_env.template

# Deploy to server
echo "🚀 Deploying to server..."

# Verify SSH connection before file transfer
echo "� Testing SSH connection..."
SSH_TEST_TIMEOUT=60
SSH_TEST_COUNTER=0

while [ $SSH_TEST_COUNTER -lt $SSH_TEST_TIMEOUT ]; do
    if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes -i ~/.ssh/id_rsa root@${VPS_IP} "echo 'SSH connection successful'" 2>/dev/null; then
        echo "✅ SSH connection test passed"
        break
    else
        echo "⏳ SSH authentication not ready, waiting... (${SSH_TEST_COUNTER}/${SSH_TEST_TIMEOUT}s)"
        sleep 10
        SSH_TEST_COUNTER=$((SSH_TEST_COUNTER + 10))
    fi
done

if [ $SSH_TEST_COUNTER -ge $SSH_TEST_TIMEOUT ]; then
    echo "❌ SSH connection test failed after ${SSH_TEST_TIMEOUT} seconds"
    echo "🔍 Debugging information:"
    echo "  - VPS IP: ${VPS_IP}"
    echo "  - Connection user: root"
    echo "  - SSH key format verified: $(head -n 1 ~/.ssh/id_rsa | grep -q 'BEGIN.*KEY' && echo 'Valid' || echo 'Invalid')"
    echo "  - Generated fingerprint: ${SSH_FINGERPRINT}"
    
    # Check if SSH key is in DigitalOcean (without exposing sensitive data)
    echo "🔑 Checking SSH key availability..."
    SSH_KEY_COUNT=$(doctl compute ssh-key list --format ID --no-header | wc -l 2>/dev/null || echo "0")
    echo "  - SSH keys in account: ${SSH_KEY_COUNT}"
    
    # Try to get more info about the droplet
    echo "🔍 Droplet information:"
    doctl compute droplet get "${INPUT_VPS_NAME}" --format ID,Name,Status,PublicIPv4,Image,Region || echo "⚠️ Failed to get droplet info"
    
    exit 1
fi

# Copy files to server
echo "📤 Copying files to server..."
# Ensure /var/www directory exists
ssh -o StrictHostKeyChecking=no -i ~/.ssh/id_rsa root@${VPS_IP} "mkdir -p /var/www"
# Copy files
scp -o StrictHostKeyChecking=no -i ~/.ssh/id_rsa -r . root@${VPS_IP}:/var/www/

# Run setup script
echo "⚙️  Running setup script on server..."

# Try streaming approach first, with fallback to background + polling
echo "📡 Attempting to stream setup script output in real-time..."
if timeout 1200 ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ConnectTimeout=60 -i ~/.ssh/id_rsa root@${VPS_IP} "cd /var/www && chmod +x setup-dc.sh && ./setup-dc.sh 2>&1 | tee /var/log/setup-dc.log"; then
    echo "✅ Setup script completed successfully"
    SETUP_EXIT_CODE=0
else
    SETUP_EXIT_CODE=$?
    if [ $SETUP_EXIT_CODE -eq 124 ]; then
        echo "⏰ Setup script timeout (20 minutes) - checking if it completed..."
        # Check if script actually completed despite timeout
        if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -i ~/.ssh/id_rsa root@${VPS_IP} "grep -q 'SETUP_COMPLETED\|Setup completed at:\|CORE_INSTALLATION_COMPLETED' /var/log/setup-dc.log 2>/dev/null"; then
            echo "✅ Setup script actually completed successfully (despite timeout)"
            SETUP_EXIT_CODE=0
        else
            echo "❌ Setup script genuinely timed out"
        fi
    else
        echo "❌ Setup script failed with exit code: ${SETUP_EXIT_CODE}"
    fi
fi

# Handle any errors
if [ $SETUP_EXIT_CODE -ne 0 ]; then
    # Try to get the log file anyway
    echo "📥 Attempting to download setup log for debugging..."
    if scp -o StrictHostKeyChecking=no -o ConnectTimeout=30 -i ~/.ssh/id_rsa root@${VPS_IP}:/var/log/setup-dc.log ./setup-dc.log 2>/dev/null; then
        echo "📋 Setup log contents:"
        tail -50 ./setup-dc.log
    else
        echo "⚠️ Could not retrieve setup log, trying to get error details..."
        # Get basic error information
        ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -i ~/.ssh/id_rsa root@${VPS_IP} "echo 'Current directory:'; pwd; echo 'Files in /var/www:'; ls -la /var/www/; echo 'Setup script permissions:'; ls -la /var/www/setup-dc.sh 2>/dev/null || echo 'setup-dc.sh not found'"
    fi
    exit 1
fi

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

# Create deployment info file for validation step
cat > deployment-info.txt << EOF
VPS_IP=${VPS_IP}
MAUTIC_URL=${MAUTIC_URL}
EOF

echo "vps-ip=${VPS_IP}" >> $GITHUB_OUTPUT
echo "mautic-url=${MAUTIC_URL}" >> $GITHUB_OUTPUT
echo "deployment-log=./setup-dc.log" >> $GITHUB_OUTPUT

echo "🎉 Deployment completed successfully!"
echo "🌐 Your Mautic instance is available at: ${MAUTIC_URL}"
echo "📧 Admin email: ${INPUT_EMAIL}"
echo "📊 Check the deployment log artifact for detailed information"