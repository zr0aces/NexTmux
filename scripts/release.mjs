import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');
const versionPath = path.join(rootDir, 'VERSION');
const packageJsonPath = path.join(rootDir, 'package.json');

// Parse CLI flags
const args = process.argv.slice(2);
const shouldBuild = args.includes('--build');
const shouldTag = args.includes('--tag');
const isHelp = args.includes('--help') || args.includes('-h');

if (isHelp) {
  console.log(`
🚀 NexTmux CalVer Release Script

Usage:
  node scripts/release.mjs [options]

Options:
  --build    Build version-tagged Docker compose images
  --tag      Create Git commit and tag for the release
  --help, -h Show this help message
`);
  process.exit(0);
}

// 1. Determine version using CalVer YYYY.M.MINOR specification
const today = new Date();
const currentYear = today.getFullYear();
const currentMonth = today.getMonth() + 1; // 1-indexed (e.g., 6 for June, no leading zero)

let currentVersion = '2026.5.0';
if (fs.existsSync(versionPath)) {
  currentVersion = fs.readFileSync(versionPath, 'utf8').trim();
} else if (fs.existsSync(packageJsonPath)) {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  currentVersion = packageJson.version || '2026.5.0';
}

const parts = currentVersion.split('.');
if (parts.length !== 3) {
  console.error(`❌ Error: Current version "${currentVersion}" is not in CalVer YYYY.M.MINOR format`);
  process.exit(1);
}

const versionYear = parseInt(parts[0], 10);
const versionMonth = parseInt(parts[1], 10);
let minor = parseInt(parts[2], 10);

if (isNaN(versionYear) || isNaN(versionMonth) || isNaN(minor)) {
  console.error(`❌ Error: Current version components in "${currentVersion}" are not valid integers`);
  process.exit(1);
}

let nextYear = currentYear;
let nextMonth = currentMonth;
let nextMinor;

if (versionYear === currentYear && versionMonth === currentMonth) {
  // Same year and month, increment minor counter
  nextMinor = minor + 1;
} else {
  // New month/year, reset minor counter to 1
  nextMinor = 1;
}

const nextVersion = `${nextYear}.${nextMonth}.${nextMinor}`;
console.log(`📅 Current system date: ${currentYear}-${currentMonth}`);
console.log(`🔄 Bumping version: ${currentVersion} ➡️  ${nextVersion}`);

// 2. Source Bumping: Update VERSION file
fs.writeFileSync(versionPath, nextVersion + '\n', 'utf8');
console.log('✅ Updated VERSION file');

// 3. Synchronization: Invoke sync-version.js to propagate version to all files
try {
  console.log(`🔄 Syncing version ${nextVersion} across files...`);
  execSync(`node scripts/sync-version.js ${nextVersion}`, { stdio: 'inherit', cwd: rootDir });
} catch (err) {
  console.error('❌ Version synchronization failed:', err.message);
  process.exit(1);
}

// 4. Build Artifacts (--build flag)
if (shouldBuild) {
  console.log('\n🐳 Building Docker images...');
  try {
    execSync('docker compose build', { stdio: 'inherit', cwd: rootDir });
    console.log('✅ Docker compose build completed successfully');
  } catch (err) {
    console.error('❌ Docker build failed:', err.message);
    process.exit(1);
  }
}

// 5. Git Commit and Tagging (--tag flag)
if (shouldTag) {
  console.log('\n🏷️  Creating Git commit and tag...');
  try {
    // Verify we are inside a Git repository
    execSync('git rev-parse --is-inside-work-tree', { stdio: 'ignore', cwd: rootDir });
    
    // Stage modified version files
    execSync('git add VERSION package.json package-lock.json index.html', { stdio: 'inherit', cwd: rootDir });
    
    // Commit changes
    execSync(`git commit -m "chore: bump version to v${nextVersion}"`, { stdio: 'inherit', cwd: rootDir });
    
    // Create annotated tag
    execSync(`git tag -a v${nextVersion} -m "Release v${nextVersion}"`, { stdio: 'inherit', cwd: rootDir });
    
    console.log(`✅ Committed and tagged as v${nextVersion}`);
    console.log(`🚀 To push the changes, run:`);
    console.log(`   git push origin main && git push origin v${nextVersion}`);
  } catch (err) {
    console.error('❌ Git commit and tag failed:', err.message);
    process.exit(1);
  }
}

console.log(`\n🎉 Release bump to v${nextVersion} completed successfully!`);
