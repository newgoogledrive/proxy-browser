// public/app.js
// Frontend: manages UI, tabs, and asks backend for meta + proxies pages via /proxy.

const newTabBtn = document.getElementById('newTabBtn');
const urlInput = document.getElementById('urlInput');
const goBtn = document.getElementById('goBtn');
const tabsList = document.getElementById('tabsList');
const iframe = document.getElementById('contentFrame');

let tabs = [];
let active = null;

function createTab(url) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2,6);
  const tab = { id, url, title: url, favicon: null };
  tabs.push(tab);
  renderTabs();
  loadTab(tab);
}

async function fetchMeta(url) {
  try {
    const resp = await fetch('/meta?url=' + encodeURIComponent(url));
    if (!resp.ok) return { title: url, favicon: null };
    const data = await resp.json();
    return data;
  } catch (e) {
    return { title: url, favicon: null };
  }
}

function renderTabs() {
  tabsList.innerHTML = '';
  tabs.forEach(t => {
    const el = document.createElement('div');
    el.className = 'tab p-2 flex items-center gap-2 border-b';
    if (active && active.id === t.id) el.classList.add('active');
    el.innerHTML = `
      <div style="width:28px;height:28px;flex:0 0 28px;">
        ${t.favicon ? `<img src="${t.favicon}" style="width:28px;height:28px;object-fit:cover"/>` : `<div class="w-7 h-7 bg-gray-200 rounded"></div>`}
      </div>
      <div class="flex-1 text-sm">
        <div class="truncate">${t.title}</div>
        <div class="text-xs text-gray-500 truncate">${t.url}</div>
      </div>
      <div class="ml-2">
        <button data-id="${t.id}" class="close text-xs px-2 py-1 bg-red-100 rounded">x</button>
      </div>
    `;
    const closeBtn = el.querySelector('.close');
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(t.id);
    });
    el.addEventListener('click', () => loadTab(t));
    tabsList.appendChild(el);
  });
}

function closeTab(id) {
  tabs = tabs.filter(t => t.id !== id);
  if (active && active.id === id) active = tabs[0] || null;
  renderTabs();
  if (active) loadTab(active);
  else iframe.src = '';
}

async function loadTab(tab) {
  active = tab;
  urlInput.value = tab.url;
  renderTabs();

  // fetch metadata for nicer tab display
  const meta = await fetchMeta(tab.url);
  tab.title = meta.title || tab.url;
  tab.favicon = meta.favicon ? '/asset?url=' + encodeURIComponent(meta.favicon) : null;
  renderTabs();

  // load proxied page into iframe
  iframe.src = '/proxy?url=' + encodeURIComponent(tab.url);
}

newTabBtn.addEventListener('click', () => createTab('https://example.com'));

goBtn.addEventListener('click', () => {
  let url = urlInput.value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  if (active) {
    active.url = url;
    loadTab(active);
  } else createTab(url);
});

// keyboard shortcuts
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key === 't') {
    e.preventDefault();
    createTab('https://example.com');
  }
  if (e.ctrlKey && e.key === 'w') {
    e.preventDefault();
    if (active) closeTab(active.id);
  }
});

// start with one tab
createTab('https://example.com');
