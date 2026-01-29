#!/bin/bash
# Rebrand FRIDAY/FRIDAY to FRIDAY
# This script performs a comprehensive find-and-replace across the codebase

set -e

PROJECT_DIR="/media/balaraj/New Volume/F.R.I.D.A.Y/F.R.I.D.A.Y"
cd "$PROJECT_DIR"

echo "🤖 Starting FRIDAY Rebrand..."
echo "================================"

# Function to replace in files (excluding .git, node_modules, dist, pnpm-lock.yaml)
replace_in_files() {
    local search="$1"
    local replace="$2"
    echo "Replacing: $search → $replace"
    
    find . -type f \
        \( -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.mjs" -o -name "*.json" -o -name "*.md" -o -name "*.yaml" -o -name "*.yml" -o -name "*.toml" -o -name "*.sh" -o -name "*.swift" -o -name "*.kt" -o -name "*.java" -o -name "*.xml" -o -name "*.html" -o -name "*.css" -o -name "*.txt" -o -name "Dockerfile*" -o -name ".env*" \) \
        ! -path "./.git/*" \
        ! -path "./node_modules/*" \
        ! -path "./dist/*" \
        ! -path "./.pnpm-store/*" \
        ! -name "pnpm-lock.yaml" \
        ! -name "*.baseline" \
        -exec sed -i "s|$search|$replace|g" {} + 2>/dev/null || true
}

# Step 1: Replace environment variable patterns (do these first to avoid partial replacements)
echo ""
echo "Step 1: Replacing environment variables..."
replace_in_files "FRIDAY_" "FRIDAY_"
replace_in_files "FRIDAY_" "FRIDAY_"

# Step 2: Replace config paths
echo ""
echo "Step 2: Replacing config paths..."
replace_in_files "\.friday" ".friday"
replace_in_files "\.friday" ".friday"
replace_in_files "/friday" "/friday"

# Step 3: Replace brand names (order matters - do longer strings first)
echo ""
echo "Step 3: Replacing brand names..."

# FRIDAY variants
replace_in_files "FRIDAY" "FRIDAY"
replace_in_files "FRIDAY" "FRIDAY"
replace_in_files "friday" "friday"
replace_in_files "friday-" "friday-"
replace_in_files "friday_" "friday_"

# FRIDAY variants
replace_in_files "FRIDAY" "FRIDAY"
replace_in_files "FRIDAY" "FRIDAY"
replace_in_files "friday" "friday"
replace_in_files "friday-" "friday-"
replace_in_files "friday_" "friday_"
replace_in_files "molt\\.bot" "friday.ai"

# Step 4: Replace lobster emoji with FRIDAY indicator
echo ""
echo "Step 4: Replacing lobster emoji..."
replace_in_files "🤖" "🤖"

# Step 5: Replace docs URLs
echo ""
echo "Step 5: Replacing documentation URLs..."
replace_in_files "docs\\.molt\\.bot" "docs.friday.ai"
replace_in_files "molt\\.bot" "friday.ai"

# Step 6: Replace package names in package.json files
echo ""
echo "Step 6: Updating package.json files..."

# Update main package.json name
if [ -f "package.json" ]; then
    sed -i 's/"name": "friday"/"name": "friday"/g' package.json
    sed -i 's/"friday":/"friday":/g' package.json
    sed -i 's/"friday":/"friday":/g' package.json
fi

# Step 7: Rename binary entry point
echo ""
echo "Step 7: Updating binary references..."
if [ -f "friday.mjs" ]; then
    cp friday.mjs friday.mjs
    echo "Created friday.mjs"
fi

# Step 8: Update CLI entry point references
replace_in_files "friday\\.mjs" "friday.mjs"

echo ""
echo "================================"
echo "🤖 FRIDAY Rebrand Complete!"
echo ""
echo "Next steps:"
echo "1. Review changes with: git diff"
echo "2. Run: pnpm install"
echo "3. Run: pnpm build"
echo "4. Test with: pnpm friday --help"
echo ""
