const assert = require('node:assert/strict');

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = value => typeof value === 'string' && value.trim().length > 0;
function isHttpUrl(value) {
  if (!isText(value)) return false;
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}

function compareVersions(left, right) {
  assert.match(left, VERSION, `无效版本号：${left}`);
  assert.match(right, VERSION, `无效版本号：${right}`);
  const a = left.split('.').map(BigInt);
  const b = right.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

// Both registration and new releases use these basic checks. Accepted snapshots
// retain their previous checks so stricter field validation does not unlist them.
function collectManifestErrors(manifest, { historical = false } = {}) {
  if (!isObject(manifest)) return ['manifest 必须是对象'];
  const errors = [];
  const check = (valid, message) => { if (!valid) errors.push(message); };
  const checkVersion = (value, field) => {
    const valid = typeof value === 'string' && VERSION.test(value);
    check(valid, `${field} 必须为三段式版本号`);
    if (valid && !historical) check(!value.split('.').slice(0, 2).some(part => part === '99' || part === '999'),
      `${field} 第一位和第二位不能填写 99 或 999`);
    return valid;
  };
  check([1, 2].includes(manifest.manifest_version), '不支持的 manifest 协议');
  checkVersion(manifest.version, 'version');
  for (const key of ['name', 'description', 'license']) check(isText(manifest[key]), `缺少有效 ${key}`);
  check(isText(manifest.author?.name), '缺少作者名称（author.name）');
  if (manifest.manifest_version === 2) {
    check(typeof manifest.id === 'string' && /^[a-zA-Z0-9_.-]+$/.test(manifest.id), '插件 ID 无效');
    if (historical) {
      check(typeof manifest.urls?.repository === 'string', '缺少 urls.repository');
      check(Array.isArray(manifest.capabilities), '缺少 capabilities');
      check(typeof manifest.i18n?.default_locale === 'string', '缺少 i18n.default_locale');
    } else {
      check(isObject(manifest.author) && isHttpUrl(manifest.author.url), 'author.url 必须为 HTTP/HTTPS URL');
      check(isObject(manifest.urls) && isHttpUrl(manifest.urls.repository), 'urls.repository 必须为 HTTP/HTTPS URL');
      for (const field of ['homepage', 'documentation', 'issues']) {
        if (manifest.urls?.[field] !== undefined) check(isHttpUrl(manifest.urls[field]), `urls.${field} 必须为 HTTP/HTTPS URL`);
      }
      check(Array.isArray(manifest.capabilities) && manifest.capabilities.every(isText), 'capabilities 必须为非空字符串数组，或空数组 []');
      check(isObject(manifest.i18n) && isText(manifest.i18n.default_locale), 'i18n.default_locale 必须为非空字符串');
      // SDK compatibility is the host's responsibility; only require a declaration.
      check(Boolean(manifest.sdk), '缺少 sdk 声明');
    }
  }
  const range = manifest.host_application;
  const minValid = checkVersion(range?.min_version, 'host_application.min_version');
  if (range?.max_version !== undefined) {
    const maxValid = checkVersion(range.max_version, 'host_application.max_version');
    if (minValid && maxValid) check(compareVersions(range.min_version, range.max_version) <= 0, 'host_application 版本范围倒置');
  }
  return errors;
}

module.exports = { VERSION, compareVersions, collectManifestErrors };
