# Mautic Deploy Action - Copilot Instructions

## Project Overview
GitHub Action for deploying Mautic 6 to DigitalOcean VPS with automated SSL, monitoring, and configuration management.

## Architecture
- **Type**: Composite GitHub Action using shell scripts
- **Platform**: DigitalOcean (doctl CLI integration)  
- **Containerization**: Docker Compose with official Mautic Apache images
- **SSL**: Automatic Let's Encrypt certificate generation (Nginx reverse proxy when domain provided)
- **Database**: MySQL 8.0 with optimized configuration

## Key Components

### Scripts
- `scripts/deploy.sh` - Main deployment orchestration
- `scripts/setup-vps.sh` - Initial VPS configuration 
- `scripts/setup.ts` - Main Mautic installation and configuration (TypeScript/Deno)

### Templates  
- `templates/docker-compose.yml` - Container definitions (Mautic Apache + MySQL)
- `templates/.env.template` - Environment configuration template
- `templates/nginx-virtual-host-template` - Nginx reverse proxy for SSL (optional)

### Examples
- `examples/basic-deployment.yml` - Simple workflow example
- `examples/advanced-deployment.yml` - Complex deployment with themes/plugins
- `examples/scheduled-deployment.yml` - Automated periodic deployments

## Development Guidelines

### Action Inputs
- **Required**: digitalocean-token, ssh-private-key, ssh-fingerprint, email, mautic-password
- **Optional**: domain, vps-size, vps-region, themes, plugins, database configuration

### Security Practices  
- Use GitHub secrets for sensitive data
- SSH key-based authentication only
- Environment variable validation
- Secure file permissions

### Testing Strategy
- Syntax validation for shell scripts and YAML
- Integration testing with minimal VPS instances
- Deployment log artifacts for debugging

## Common Tasks

### Adding New Features
1. Update `action.yml` with new inputs
2. Modify deployment scripts to handle new parameters
3. Update templates if configuration changes needed
4. Add examples demonstrating new functionality
5. Update README.md documentation

### Troubleshooting
- Check deployment log artifacts
- SSH to VPS for direct debugging: `ssh root@VPS_IP`
- Review Docker logs: `docker-compose logs -f`
- Verify DNS configuration for domain deployments

### Maintenance
- Keep Mautic version defaults updated
- Monitor DigitalOcean API changes
- Update security practices as needed
- Review and update example workflows