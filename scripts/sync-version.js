const fs = require('fs');
const path = require('path');

// Paths
const rootDir = path.join(__dirname, '..');
const versionPath = path.join(rootDir, 'VERSION');
const packageJsonPath = path.join(rootDir, 'package.json');
const packageLockJsonPath = path.join(rootDir, 'package-lock.json');
const indexHtmlPath = path.join(rootDir, 'index.html');

// Determine version
let version = process.argv[2];

if (version) {
  // Strip optional 'v' prefix
  if (version.startsWith('v')) {
    version = version.slice(1);
  }
  // Validate format (CalVer YYYY.M.Micro)
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    console.error('❌ Error: Version must match major.minor.patch style (e.g., 2026.5.1 or v2026.5.1)');
    process.exit(1);
  }
} else {
  // CalVer resolution logic (auto-increment patch if in same year/month, else reset to 1)
  const today = new Date();
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth() + 1; // 1-indexed (e.g., 5 for May)

  let currentVersion = '2026.5.0';
  if (fs.existsSync(versionPath)) {
    currentVersion = fs.readFileSync(versionPath, 'utf8').trim();
  } else if (fs.existsSync(packageJsonPath)) {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    currentVersion = packageJson.version || '2026.5.0';
  }

  const parts = currentVersion.split('.');
  
  if (parts.length !== 3) {
    console.error(`❌ Error: Current version "${currentVersion}" is not in CalVer YYYY.M.Micro format`);
    process.exit(1);
  }

  const versionYear = parseInt(parts[0], 10);
  const versionMonth = parseInt(parts[1], 10);
  let patch = parseInt(parts[2], 10);

  if (isNaN(versionYear) || isNaN(versionMonth) || isNaN(patch)) {
    console.error(`❌ Error: Current version components are not valid integers`);
    process.exit(1);
  }

  if (versionYear === currentYear && versionMonth === currentMonth) {
    // Same month and year, increment patch
    patch = patch + 1;
  } else {
    // New month/year, reset patch component to 1
    patch = 1;
  }

  version = `${currentYear}.${currentMonth}.${patch}`;
}

console.log(`🔄 Syncing version: v${version}`);

// 0. Sync VERSION
fs.writeFileSync(versionPath, version + '\n', 'utf8');
console.log('✅ Updated VERSION');

// 1. Sync package.json
if (fs.existsSync(packageJsonPath)) {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  packageJson.version = version;
  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
  console.log('✅ Updated package.json');
}

// 2. Sync package-lock.json
if (fs.existsSync(packageLockJsonPath)) {
  const packageLockJson = JSON.parse(fs.readFileSync(packageLockJsonPath, 'utf8'));
  packageLockJson.version = version;
  if (packageLockJson.packages && packageLockJson.packages['']) {
    packageLockJson.packages[''].version = version;
  }
  fs.writeFileSync(packageLockJsonPath, JSON.stringify(packageLockJson, null, 2) + '\n', 'utf8');
  console.log('✅ Updated package-lock.json');
}

// 3. Sync index.html asset query parameters and login page badge
if (fs.existsSync(indexHtmlPath)) {
  let indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
  
  // Replace asset version query parameter: .css?v=... or .js?v=...
  let updatedHtml = indexHtml.replace(/(\.css|\.js)\?v=[^"\s>]+/g, `$1?v=${version}`);
  
  // Replace login-version display badge: <span class="login-version">v...</span>
  updatedHtml = updatedHtml.replace(/(class="login-version">)v[^<]+/g, `$1v${version}`);

  // Replace app-version display badge: <span class="app-version">v...</span>
  updatedHtml = updatedHtml.replace(/(class="app-version">)v[^<]+/g, `$1v${version}`);
  
  fs.writeFileSync(indexHtmlPath, updatedHtml, 'utf8');
  console.log('✅ Updated index.html asset cachebusters, login version badge, and app version badge');
}

console.log(`🎉 Version sync complete! Version is now v${version}`);

console.log(`\n🏷️  To update git tags for this release, run:`);
console.log(`   git add VERSION package.json package-lock.json index.html`);
console.log(`   git commit -m "chore: bump version to v${version}"`);
console.log(`   git tag -a v${version} -m "Release v${version}"`);
console.log(`   git push origin v${version}`);
