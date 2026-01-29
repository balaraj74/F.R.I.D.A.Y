#!/bin/bash
# Rename files containing clawdbot/moltbot to friday
set -e

PROJECT_DIR="/media/balaraj/New Volume/F.R.I.D.A.Y/F.R.I.D.A.Y"
cd "$PROJECT_DIR"

echo "🤖 Renaming files with clawdbot/moltbot to friday..."

# Find and rename files
find . -type f \( -name "*clawdbot*" -o -name "*moltbot*" \) \
    ! -path "./.git/*" \
    ! -path "./node_modules/*" \
    ! -path "./dist/*" \
    ! -path "./packages/*/node_modules/*" \
    ! -path "./extensions/*/node_modules/*" \
    2>/dev/null | while read -r file; do
    
    newname=$(echo "$file" | sed 's/clawdbot/friday/g' | sed 's/moltbot/friday/g')
    
    if [ "$file" != "$newname" ]; then
        # Create directory if needed
        mkdir -p "$(dirname "$newname")"
        
        # Rename the file
        mv "$file" "$newname" 2>/dev/null || echo "Failed to rename: $file"
        echo "Renamed: $file -> $newname"
    fi
done

echo ""
echo "🤖 File renaming complete!"
