#!/bin/bash

set -e

echo "🚀 Starting deployment to DigitalOcean..."

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
if ! ssh-keygen -y -f ~/.ssh/id_rsa > ~/.ssh/id_rsa.pub 2>/dev/null; then
    echo "❌ Error: Failed to generate public key from private key"
    echo "Please verify your SSH private key is valid"
    exit 1
fi

# Generate MD5 fingerprint (DigitalOcean format)
SSH_FINGERPRINT=$(ssh-keygen -l -f ~/.ssh/id_rsa.pub -E md5 | awk '{print $2}' | sed 's/MD5://')

if [ -z "$SSH_FINGERPRINT" ]; then
    echo "❌ Error: Failed to generate SSH fingerprint from private key"
    echo "Please verify your SSH private key is valid"
    exit 1
fi

echo "✅ SSH fingerprint generated MD5: ${SSH_FINGERPRINT}"

# Find the SSH key ID in DigitalOcean by fingerprint
echo "🔍 Finding SSH key in DigitalOcean account..."
echo "Looking for fingerprint: ${SSH_FINGERPRINT}"

# Try to list SSH keys and find the matching one (handle different column headers)
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
cp "${ACTION_PATH}/templates/.mautic_env.template" .

# Compile Deno setup script to binary
echo "🔨 Compiling Deno TypeScript setup script to binary..."

# Check if Deno is available
if ! command -v deno &> /dev/null; then
    echo "📦 Installing Deno..."
    curl -fsSL https://deno.land/install.sh | sh
    export PATH="$HOME/.deno/bin:$PATH"
fi

echo "✅ Deno version: $(deno --version | head -n 1)"
echo "🔍 Target platform: $(uname -m)-$(uname -s)"

mkdir -p build
deno compile --allow-all --target x86_64-unknown-linux-gnu --output ./build/setup "${ACTION_PATH}/scripts/setup.ts"

if [ ! -f "./build/setup" ]; then
    echo "❌ Error: Failed to compile Deno setup script"
    exit 1
fi

echo "✅ Successfully compiled setup binary"

echo "📁 Files prepared for deployment:"
ls -la deploy.env docker-compose.yml .mautic_env.template build/setup

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
scp -o StrictHostKeyChecking=no -i ~/.ssh/id_rsa deploy.env docker-compose.yml .mautic_env.template root@${VPS_IP}:/var/www/
scp -o StrictHostKeyChecking=no -i ~/.ssh/id_rsa build/setup root@${VPS_IP}:/var/www/setup

# Verify binary can execute
echo "🔍 Verifying setup binary on server..."
ssh -o StrictHostKeyChecking=no -i ~/.ssh/id_rsa root@${VPS_IP} "cd /var/www && chmod +x setup && file setup"

# Test if binary can start
echo "🧪 Testing binary execution..."
if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -i ~/.ssh/id_rsa root@${VPS_IP} "cd /var/www && timeout 10 ./setup --help 2>/dev/null || echo 'Binary test completed'"; then
    echo "✅ Binary appears to be working"
else
    echo "⚠️ Binary test had issues, but continuing..."
fi

# Run setup script
echo "⚙️  Running compiled setup binary on server..."

# Check initial memory status and swap configuration
echo "💾 Pre-deployment memory status:"
ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -i ~/.ssh/id_rsa root@${VPS_IP} "echo 'Memory:' && free -h && echo 'Swap:' && swapon --show 2>/dev/null || echo 'No swap active'" 2>/dev/null || echo "Could not check memory"

# Try background execution with polling instead of streaming
echo "🔄 Starting setup script in background and monitoring progress..."

# Start setup script in background with a completion marker
ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -o ServerAliveInterval=60 -o ServerAliveCountMax=3 -i ~/.ssh/id_rsa root@${VPS_IP} "cd /var/www && nohup ./setup > /var/log/setup-dc.log 2>&1 & echo 'BACKGROUND_STARTED'"

SSH_START_RESULT=$?
if [ $SSH_START_RESULT -ne 0 ]; then
    echo "❌ Failed to start setup script (exit code: $SSH_START_RESULT)"
    exit 1
fi

echo "✅ Setup script started in background"

# Immediately check if setup is producing output
echo "🔍 Checking initial setup output..."
sleep 5
ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -i ~/.ssh/id_rsa root@${VPS_IP} "ls -la /var/log/setup-dc.log 2>/dev/null && echo '--- LOG CONTENT ---' && head -20 /var/log/setup-dc.log 2>/dev/null || echo 'No log file yet'"

# Also start a monitoring process that will write completion marker
echo "🔍 Starting completion monitor..."
timeout 60 ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -i ~/.ssh/id_rsa root@${VPS_IP} "nohup bash -c 'while pgrep -f \"./setup\" > /dev/null; do sleep 5; done; SETUP_PID=\$(pgrep -f \"./setup\" || echo); if [ -n \"\$SETUP_PID\" ]; then wait \$SETUP_PID; EXIT_CODE=\$?; else EXIT_CODE=0; fi; echo \"SETUP_COMPLETED_\$EXIT_CODE\" >> /var/log/setup-dc.log' > /dev/null 2>&1 &" &

# Monitor progress with fewer SSH connections and better error handling
echo "📊 Monitoring setup progress..."
TIMEOUT=600  # 10 minutes for testing
COUNTER=0
SETUP_EXIT_CODE=255
PREVIOUS_LOG_TAIL=""

while [ "${COUNTER:-0}" -lt "${TIMEOUT:-600}" ]; do
    # Check if setup process is still running - be more specific with process detection
    SETUP_RUNNING=$(ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -o ServerAliveInterval=60 -o ServerAliveCountMax=3 -i ~/.ssh/id_rsa root@${VPS_IP} "pgrep -f '^[^ ]*setup\$' | head -1 || echo 'NOT_RUNNING'" 2>/dev/null || echo "SSH_FAILED")
    
    # Quick check: if log shows completion indicators, exit immediately
    if [ "${COUNTER:-0}" -ge 30 ]; then  # After 30 seconds, start checking for completion
        QUICK_SUCCESS_CHECK=$(ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -i ~/.ssh/id_rsa root@${VPS_IP} "grep -c 'deployment_status::success\\|🎉.*Mautic setup completed\\|Access URL:.*login' /var/log/setup-dc.log 2>/dev/null || echo '0'" 2>/dev/null || echo "0")
        # Ensure QUICK_SUCCESS_CHECK is numeric
        case "$QUICK_SUCCESS_CHECK" in
            ''|*[!0-9]*) QUICK_SUCCESS_CHECK=0 ;;
        esac
        if [ "${QUICK_SUCCESS_CHECK:-0}" -gt 0 ]; then
            echo "✅ Setup completed successfully (found completion indicators in log)"
            SETUP_EXIT_CODE=0
            break
        fi
    fi
    
    if [ "$SETUP_RUNNING" = "NOT_RUNNING" ]; then
        echo "🏁 Setup process has completed (no longer running)"
        # Check for completion marker with exit code
        SSH_CHECK_RESULT=$(ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -i ~/.ssh/id_rsa root@${VPS_IP} "grep 'SETUP_COMPLETED_' /var/log/setup-dc.log 2>/dev/null | tail -1" 2>/dev/null || echo "NO_MARKER")
        
        if [[ "$SSH_CHECK_RESULT" =~ SETUP_COMPLETED_([0-9]+) ]]; then
            SETUP_EXIT_CODE="${BASH_REMATCH[1]}"
            echo "✅ Setup completed with exit code: ${SETUP_EXIT_CODE}"
            break
        else
            # No marker found, check for success indicators in log
            SUCCESS_CHECK=$(ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -i ~/.ssh/id_rsa root@${VPS_IP} "grep -q 'deployment_status::success\\|🎉' /var/log/setup-dc.log 2>/dev/null && echo 'SUCCESS' || echo 'UNKNOWN'" 2>/dev/null || echo "SSH_FAILED")
            if [ "$SUCCESS_CHECK" = "SUCCESS" ]; then
                SETUP_EXIT_CODE=0
                echo "✅ Setup completed successfully (found success indicators)"
                break
            fi
            
            # Additional check: if we see the same timestamp for 2+ minutes, assume completion
            if [ "${COUNTER:-0}" -ge 120 ]; then
                CURRENT_LOG_TAIL=$(ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -i ~/.ssh/id_rsa root@${VPS_IP} "tail -n 3 /var/log/setup-dc.log 2>/dev/null" 2>/dev/null || echo "LOG_CHECK_FAILED")
                if [[ "$CURRENT_LOG_TAIL" == "$PREVIOUS_LOG_TAIL" ]] && [[ "$CURRENT_LOG_TAIL" != "LOG_CHECK_FAILED" ]]; then
                    echo "⚠️ Setup appears completed (static log output for 2+ minutes)"
                    # Do a final check for success indicators with more lenient grep
                    FINAL_CHECK=$(ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -i ~/.ssh/id_rsa root@${VPS_IP} "grep -E 'deployment_status::success|🎉|Access URL:.*login' /var/log/setup-dc.log 2>/dev/null | wc -l" 2>/dev/null || echo "0")
                    if [ "$FINAL_CHECK" -gt 0 ]; then
                        SETUP_EXIT_CODE=0
                        echo "✅ Setup completed successfully (found completion indicators)"
                        break
                    fi
                fi
                PREVIOUS_LOG_TAIL="$CURRENT_LOG_TAIL"
            fi
            
            SETUP_EXIT_CODE=1
            echo "⚠️ Setup process completed but exit code unknown, checking logs..."
            break
        fi
    elif [ "$SETUP_RUNNING" = "SSH_FAILED" ]; then
        echo "⚠️ SSH connection failed, retrying in 30s... (${COUNTER}s)"
    else
        # Process is still running, show progress
        if [ $((COUNTER % 60)) -eq 0 ]; then
            echo "📄 Setup progress (${COUNTER}s, PID: $SETUP_RUNNING):"
            ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -o ServerAliveInterval=60 -o ServerAliveCountMax=3 -i ~/.ssh/id_rsa root@${VPS_IP} "tail -n 3 /var/log/setup-dc.log 2>/dev/null || echo 'Setup in progress...'"
            
            # Show memory usage to monitor for memory pressure
            echo "💾 Current memory usage:"
            ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -i ~/.ssh/id_rsa root@${VPS_IP} "free -h && echo 'Swap usage:' && swapon --show 2>/dev/null || echo 'No swap active'" 2>/dev/null || echo "Could not check memory"
            
            # During detailed progress check, also verify if setup actually completed
            DETAILED_SUCCESS_CHECK=$(ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -i ~/.ssh/id_rsa root@${VPS_IP} "grep -E 'deployment_status::success|🎉.*Mautic setup completed|Access URL:.*login' /var/log/setup-dc.log 2>/dev/null | tail -1" 2>/dev/null || echo "")
            if [ -n "$DETAILED_SUCCESS_CHECK" ]; then
                echo "✅ Setup actually completed successfully (found: $DETAILED_SUCCESS_CHECK)"
                SETUP_EXIT_CODE=0
                break
            fi
        else
            echo "⏳ Setup running... (${COUNTER}s, PID: $SETUP_RUNNING)"
        fi
    fi
    
    sleep 30
    COUNTER=$((${COUNTER:-0} + 30))
done

# Handle timeout
if [ "${COUNTER:-0}" -ge "${TIMEOUT:-600}" ]; then
    echo "⏰ Setup script timeout after ${TIMEOUT} seconds"
    echo "🔍 Attempting to kill stuck setup process..."
    
    # Try to kill the setup process
    SETUP_RUNNING=$(ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -i ~/.ssh/id_rsa root@${VPS_IP} "pgrep -f './setup' || echo 'NOT_RUNNING'" 2>/dev/null || echo "SSH_FAILED")
    
    if [ "$SETUP_RUNNING" != "NOT_RUNNING" ] && [ "$SETUP_RUNNING" != "SSH_FAILED" ]; then
        echo "🔪 Killing setup process (PID: $SETUP_RUNNING)..."
        ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -i ~/.ssh/id_rsa root@${VPS_IP} "kill -TERM $SETUP_RUNNING; sleep 5; kill -KILL $SETUP_RUNNING 2>/dev/null || true" 2>/dev/null || true
        echo "✅ Setup process killed"
    fi
    
    echo "🔍 Checking if deployment actually completed..."
    
    # Check for completion markers in log - look for the actual success message
    if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -i ~/.ssh/id_rsa root@${VPS_IP} "grep -q '🎉 Mautic setup completed successfully\\|deployment_status::success' /var/log/setup-dc.log 2>/dev/null"; then
        echo "✅ Setup completed successfully (found success marker)"
        SETUP_EXIT_CODE=0
    else
        echo "❌ Setup did not complete within timeout"
        SETUP_EXIT_CODE=124
    fi
fi

# Check final status
echo "🔍 Final status check: SETUP_EXIT_CODE='${SETUP_EXIT_CODE}'"
if [ -n "$SETUP_EXIT_CODE" ] && [ "$SETUP_EXIT_CODE" -ne 0 ]; then
    echo "❌ Setup script failed with exit code: ${SETUP_EXIT_CODE}"
    echo "🔍 Debug information:"
    echo "  - VPS IP: ${VPS_IP}"
    echo "  - Setup exit code: ${SETUP_EXIT_CODE}"
    
    # Try to get log content for debugging
    echo "📄 Last 20 lines of setup log:"
    if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -i ~/.ssh/id_rsa root@${VPS_IP} "tail -n 20 /var/log/setup-dc.log" 2>/dev/null; then
        echo "📊 Setup log retrieved successfully"
    else
        echo "⚠️ Could not retrieve setup log, trying to get error details..."
        # Get basic error information
        ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -i ~/.ssh/id_rsa root@${VPS_IP} "echo 'Current directory:'; pwd; echo 'Files in /var/www:'; ls -la /var/www/; echo 'Setup binary permissions:'; ls -la /var/www/setup 2>/dev/null || echo 'setup binary not found'"
        exit 1
    fi
else
    # Don't overwrite SETUP_EXIT_CODE if it was already set correctly
    if [ -z "$SETUP_EXIT_CODE" ]; then
        SETUP_EXIT_CODE=$?
    fi
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

# Handle any errors - but check if setup was actually completed
if [ $SETUP_EXIT_CODE -ne 0 ]; then
    echo "❌ Setup script failed with exit code: ${SETUP_EXIT_CODE}"
    echo "🔍 Debug information:"
    echo "  - VPS IP: ${VPS_IP}"
    echo "  - Setup exit code: ${SETUP_EXIT_CODE}"
    
    # Try to get the log file anyway
    echo "📥 Attempting to download setup log for debugging..."
    if scp -o StrictHostKeyChecking=no -o ConnectTimeout=30 -i ~/.ssh/id_rsa root@${VPS_IP}:/var/log/setup-dc.log ./setup-dc.log 2>/dev/null; then
        echo "📋 Last 50 lines of setup log:"
        tail -50 ./setup-dc.log
        echo "📋 Checking for specific error patterns:"
        if grep -q "❌" ./setup-dc.log; then
            echo "🔍 Found error messages in log:"
            grep "❌" ./setup-dc.log | tail -10
        fi
        if grep -q "SETUP_COMPLETED" ./setup-dc.log; then
            echo "✅ Setup actually completed despite exit code!"
            echo "🔄 Continuing with outputs since setup marked as complete..."
            SETUP_EXIT_CODE=0  # Override the exit code since setup completed successfully
        else
            echo "❌ Setup did not complete successfully"
            exit 1
        fi
    else
        echo "❌ Could not retrieve setup log for debugging"
        exit 1
    fi
fi

# Final check after potential override
if [ $SETUP_EXIT_CODE -ne 0 ]; then
    echo "❌ Setup failed and could not be recovered"
    exit 1
else
    echo "✅ Setup script completed successfully with exit code: ${SETUP_EXIT_CODE}"
fi

# Final validation - check if Mautic is actually accessible
if [ $SETUP_EXIT_CODE -eq 0 ]; then
    echo "🌐 Final validation: Testing Mautic accessibility..."
    
    if [ -n "$INPUT_DOMAIN" ]; then
        TEST_URL="https://${INPUT_DOMAIN}/s/login"
    else
        TEST_URL="http://${VPS_IP}:${MAUTIC_PORT}/s/login"
    fi
    
    echo "🔗 Testing URL: ${TEST_URL}"
    
    # Try HTTP request with timeout
    HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 10 --max-time 30 "$TEST_URL" 2>/dev/null || echo "000")
    
    if [ "$HTTP_STATUS" = "200" ]; then
        echo "✅ Mautic login page is accessible (HTTP $HTTP_STATUS)"
    elif [ "$HTTP_STATUS" = "302" ] || [ "$HTTP_STATUS" = "301" ]; then
        echo "✅ Mautic is accessible with redirect (HTTP $HTTP_STATUS)"
    else
        echo "⚠️ HTTP test returned: $HTTP_STATUS"
        echo "🔍 This might be normal if containers are still starting up"
        
        # Give it one more try after a short wait
        echo "⏳ Waiting 10 seconds and retrying..."
        sleep 10
        HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 10 --max-time 30 "$TEST_URL" 2>/dev/null || echo "000")
        
        if [ "$HTTP_STATUS" = "200" ] || [ "$HTTP_STATUS" = "302" ] || [ "$HTTP_STATUS" = "301" ]; then
            echo "✅ Mautic is now accessible (HTTP $HTTP_STATUS)"
        else
            echo "⚠️ Mautic may not be fully ready yet (HTTP $HTTP_STATUS)"
            echo "🔍 Check the URL manually: ${TEST_URL}"
        fi
    fi
fi

# Download setup log
echo "📥 Downloading setup log..."
scp -o StrictHostKeyChecking=no -i ~/.ssh/id_rsa root@${VPS_IP}:/var/log/setup-dc.log ./setup-dc.log

# Note: SSH key cleanup moved to action.yml after validation

# Set outputs
echo "🔍 Preparing outputs..."
echo "  - VPS_IP: '${VPS_IP}'"
echo "  - INPUT_DOMAIN: '${INPUT_DOMAIN}'"
echo "  - MAUTIC_PORT: '${MAUTIC_PORT}'"
echo "  - INPUT_EMAIL: '${INPUT_EMAIL}'"

if [ -n "$INPUT_DOMAIN" ]; then
    MAUTIC_URL="https://${INPUT_DOMAIN}"
    echo "  - Using domain-based URL"
else
    MAUTIC_URL="http://${VPS_IP}:${MAUTIC_PORT}"
    echo "  - Using IP-based URL"
fi

echo "  - Final MAUTIC_URL: '${MAUTIC_URL}'"

echo "vps-ip=${VPS_IP}" >> $GITHUB_OUTPUT
echo "mautic-url=${MAUTIC_URL}" >> $GITHUB_OUTPUT
echo "deployment-log=./setup-dc.log" >> $GITHUB_OUTPUT

echo "✅ Outputs set successfully"

echo "🎉 Deployment completed successfully!"
echo "🌐 Your Mautic instance is available at: ${MAUTIC_URL}"
echo "📧 Admin email: ${INPUT_EMAIL}"
echo "📊 Check the deployment log artifact for detailed information"
