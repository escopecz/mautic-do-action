# Mautic with Custom Plugins Example

This example demonstrates deploying Mautic with custom plugins using the Mautic Deploy Action's custom image feature.

## Features Demonstrated

- **Custom Docker Image**: Automatically builds a custom Mautic image with your plugins pre-installed
- **Build-time Installation**: Plugins are installed during image build, not at runtime
- **Follows Official Pattern**: Uses the same approach as the official Mautic docker-mautic examples
- **Zero Runtime Complexity**: No SSH keys, git operations, or runtime downloads needed

## Quick Start

```yaml
name: Deploy Mautic with Custom Plugins
on:
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Deploy Mautic with Custom Plugins
        uses: escopecz/mautic-do-action@main
        with:
          digitalocean-token: ${{ secrets.DIGITALOCEAN_TOKEN }}
          ssh-private-key: ${{ secrets.SSH_PRIVATE_KEY }}
          ssh-fingerprint: ${{ secrets.SSH_FINGERPRINT }}
          email: admin@yourdomain.com
          mautic-password: ${{ secrets.MAUTIC_PASSWORD }}
          
          # Custom plugins (comma-separated URLs)
          plugins: |
            https://github.com/username/custom-plugin-1/archive/refs/heads/main.zip,
            https://github.com/username/custom-plugin-2/archive/refs/heads/main.zip
          
          # Custom themes (comma-separated URLs)  
          themes: |
            https://github.com/username/custom-theme/archive/refs/heads/main.zip
```

## How It Works

1. **Detection**: Action detects that plugins/themes are specified
2. **Custom Image Build**: Creates a Dockerfile based on official Mautic image
3. **Content Download**: Downloads and extracts plugins/themes to build context
4. **Image Build**: Builds custom image with `docker build`
5. **Deployment**: Uses custom image in docker-compose instead of official image

## Advantages over Runtime Installation

✅ **Faster Startup**: No download/installation during container startup  
✅ **More Reliable**: No network dependencies at runtime  
✅ **Consistent**: Plugins always available, no installation race conditions  
✅ **Official Pattern**: Follows recommended approach from Mautic team  
✅ **Simpler**: No SSH keys or complex runtime logic needed  

## Plugin/Theme URL Formats

Supported URL formats:
- **GitHub Archives**: `https://github.com/user/repo/archive/refs/heads/main.zip`
- **Direct ZIP Files**: `https://example.com/plugin.zip`
- **Tagged Releases**: `https://github.com/user/repo/archive/refs/tags/v1.0.0.zip`

## Generated Structure

The action creates this build structure:
```
build/
├── Dockerfile
├── plugins/
│   ├── CustomPlugin1/
│   └── CustomPlugin2/
└── themes/
    └── CustomTheme/
```

## Environment Variables

All standard Mautic environment variables are supported:
- Database configuration
- Admin user settings  
- Mautic behavior settings
- Custom application settings

## Production Considerations

- **Image Registry**: Consider pushing custom images to a registry for production
- **Build Caching**: Docker build cache can speed up rebuilds
- **Version Pinning**: Use specific tags/commits for reproducible builds
- **Security**: Ensure plugin/theme sources are trusted

## Troubleshooting

**Build Failures**: Check that plugin/theme URLs are accessible and contain valid Mautic extensions

**Plugin Not Loading**: Verify plugin structure matches Mautic requirements after extraction

**Permission Issues**: The Dockerfile handles ownership automatically, but check if custom plugins need specific permissions