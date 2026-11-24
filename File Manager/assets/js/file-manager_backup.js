(function(){
  var NOUN = document.body.dataset.noun || 'folder';
  var NOUN_CAP = NOUN.charAt(0).toUpperCase() + NOUN.slice(1);

  const pickBtn = document.getElementById('pickBtn');
  const reconnectBtn = document.getElementById('reconnectBtn');
  const forgetBtn = document.getElementById('forgetBtn');
  const rootPathLabel = document.getElementById('rootPathLabel');
  const treeContainer = document.getElementById('treeContainer');
  const unsupportedNotice = document.getElementById('unsupportedNotice');
  const fallbackNotice = document.getElementById('fallbackNotice');
  const folderInputFallback = document.getElementById('folderInputFallback');
  const previewMeta = document.getElementById('previewMeta');
  const previewGutter = document.getElementById('previewGutter');
  const previewCode = document.getElementById('previewCode');
  const deleteBtn = document.getElementById('deleteBtn');
  const targetDirField = document.getElementById('targetDirField');
  const targetDirSelect = document.getElementById('targetDirSelect');
  const createPanelHeading = document.getElementById('createPanelHeading');
  const extSelect = document.getElementById('extSelect');
  const extCustom = document.getElementById('extCustom');
  const createBtn = document.getElementById('createBtn');
  const logBox = document.getElementById('logBox');
  const clearLogBtn = document.getElementById('clearLogBtn');

  let rootHandle = null;
  let rootNode = null;
  let nodesByPath = {};
  let activeFilePath = null;
  let hasWritePermission = false;

  // Runs `mapper` over `items` with at most `limit` in flight at once — lets file
  // reads overlap instead of waiting on each one before starting the next.
  async function mapWithConcurrency(items, limit, mapper){
    let idx = 0;
    const workerCount = Math.max(1, Math.min(limit, items.length));
    const workers = new Array(workerCount).fill(0).map(async () => {
      while(idx < items.length){
        const current = idx++;
        await mapper(items[current], current);
      }
    });
    await Promise.all(workers);
  }

  async function readFileText(node){
    try{
      const file = await node.handle.getFile();
      const rawText = await file.text();
      return isRtf(node.name) ? stripRtf(rawText) : rawText;
    } catch(e){
      return null;
    }
  }

  // ---- Memory-aware read strategy ----
  // On low-memory devices (or when the tab is already under heap pressure),
  // reading many files in parallel risks spiking memory. In that case, fall
  // back to the old one-file-at-a-time approach instead of the concurrent one.
  const LOW_DEVICE_MEMORY_GB = 8;   // navigator.deviceMemory below this = low-memory device
  const HIGH_HEAP_USAGE_PCT = 75;   // JS heap usage above this % = under memory pressure

  function shouldReadSequentially(){
    if('deviceMemory' in navigator && navigator.deviceMemory < LOW_DEVICE_MEMORY_GB) return true;
    if(performance.memory && performance.memory.jsHeapSizeLimit){
      const usedPct = (performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit) * 100;
      if(usedPct > HIGH_HEAP_USAGE_PCT) return true;
    }
    return false;
  }

  function matchFile(f, text, keywords){
    if(text == null) return null; // unreadable or binary — skip
    if(!keywords.every(k => text.includes(k))) return null;
    const lines = text.split('\n');
    const lineHits = {};
    keywords.forEach(k => { lineHits[k] = []; });
    lines.forEach((lineText, idx) => {
      keywords.forEach(k => {
        if(lineText.includes(k)) lineHits[k].push(idx + 1);
      });
    });
    return { path: f.path, lineHits };
  }

  // ---- Remembering the picked directory across visits (avoids re-running the OS folder picker) ----
  const IDB_NAME = 'fm-handle-store';
  const IDB_STORE = 'handles';
  const IDB_KEY = 'rootHandle';

  function openHandleDB(){
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveHandle(handle){
    try{
      const db = await openHandleDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put(handle, IDB_KEY);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } catch(e){ /* non-fatal: worst case, folder isn't remembered next visit */ }
  }

  async function loadSavedHandle(){
    try{
      const db = await openHandleDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch(e){ return null; }
  }

  async function forgetSavedHandle(){
    try{
      const db = await openHandleDB();
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(IDB_KEY);
    } catch(e){}
  }

  // Only actually shows a permission dialog if the browser hasn't already granted
  // write access for this handle — otherwise resolves silently.
  async function ensureWritePermission(handle){
    const opts = { mode: 'readwrite' };
    if((await handle.queryPermission(opts)) === 'granted'){ hasWritePermission = true; return true; }
    if((await handle.requestPermission(opts)) === 'granted'){ hasWritePermission = true; return true; }
    hasWritePermission = false;
    return false;
  }

  // Drops all references to the previously loaded folder (handles, tree nodes,
  // open preview) before loading a new one, so the old folder's data can be
  // garbage-collected instead of sitting in memory alongside the new one.
  function resetDirectoryState(){
    rootHandle = null;
    rootNode = null;
    nodesByPath = {};
    activeFilePath = null;
    hasWritePermission = false;
    closePreview();
    treeContainer.innerHTML = '<p class="empty-tree">Loading…</p>';
    targetDirSelect.innerHTML = '<option value="">Select a ' + NOUN + ' first</option>';
  }

  async function loadDirectory(handle, opts){
    opts = opts || {};
    resetDirectoryState();
    rootHandle = handle;
    rootPathLabel.innerHTML = NOUN_CAP + ': <b>' + esc(rootHandle.name) + '</b>';
    await refreshTree();
    if(reconnectBtn) reconnectBtn.style.display = 'none';
    if(forgetBtn) forgetBtn.style.display = 'inline-block';
    if(!opts.silent) log(NOUN_CAP + ' selected: ' + rootHandle.name, 'success');
    else log('Reconnected to previously selected ' + NOUN + ': ' + rootHandle.name, 'success');
    await saveHandle(handle); // overwrites any previously remembered folder — old one is forgotten
  }

  const supportsFSA = 'showDirectoryPicker' in window;
  const supportsDirInput = (function(){
    const el = document.createElement('input');
    return 'webkitdirectory' in el;
  })();
  const fallbackMode = !supportsFSA && supportsDirInput;

  if(!supportsFSA && !supportsDirInput){
    unsupportedNotice.style.display = 'block';
    pickBtn.disabled = true;
  } else if(fallbackMode){
    fallbackNotice.style.display = 'block';
    if(targetDirField) targetDirField.style.display = 'none';
    if(createPanelHeading) createPanelHeading.textContent = 'Download a File';
    createBtn.textContent = 'Download File';

    if(navigator.brave && typeof navigator.brave.isBrave === 'function'){
      navigator.brave.isBrave().then((isBrave) => {
        if(!isBrave) return;
        fallbackNotice.innerHTML = 'You\'re using <b>Brave</b>, which disables this API by default for privacy — even though Brave is Chromium-based. To turn on full read/write access: open <b>brave://flags</b> search for &ldquo;File System Access API,&rdquo; enable it, and relaunch Brave. Until then, this page runs in <b>read-only preview mode</b>: browse, search, and preview files freely, and any file you create downloads instead of saving in place.';

        const copyBtn = document.getElementById('braveFlagsCopyBtn');
        if(copyBtn){
          copyBtn.addEventListener('click', async () => {
            const url = 'brave://flags/#file-system-access-api';
            try{
              await navigator.clipboard.writeText(url);
              copyBtn.textContent = 'Copied!';
            } catch(e){
              copyBtn.textContent = 'Copy failed — select and copy manually';
            }
            setTimeout(() => { copyBtn.textContent = 'Copy link'; }, 2000);
          });
        }
      }).catch(() => {});
    }
  }

  clearLogBtn.addEventListener('click', () => {
    logBox.innerHTML = '';
  });

  function log(text, type){
    const line = document.createElement('div');
    line.className = 'log-line ' + (type || 'info');
    line.innerHTML = '<span class="p">$</span> ' + text;
    logBox.appendChild(line);
    logBox.scrollTop = logBox.scrollHeight;
  }

  function logHtml(html, type){
    const line = document.createElement('div');
    line.className = 'log-line ' + (type || 'info');
    line.innerHTML = html;
    logBox.appendChild(line);
    logBox.scrollTop = logBox.scrollHeight;
  }

  function esc(s){
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function isRtf(name){
    return name.toLowerCase().endsWith('.rtf');
  }

  function stripRtf(rtf){
    let text = rtf;
    text = text.replace(/\{\\(fonttbl|colortbl|stylesheet|info|pict|object|\*)[\s\S]*?\}(?=[\\{}]|$)/gi, '');
    text = text.replace(/\\par[d]?\b ?/g, '\n');
    text = text.replace(/\\line\b ?/g, '\n');
    text = text.replace(/\\tab\b ?/g, '\t');
    text = text.replace(/\\'[0-9a-fA-F]{2}/g, '');
    text = text.replace(/\\[a-zA-Z]+-?\d* ?/g, '');
    text = text.replace(/[{}]/g, '');
    return text.replace(/\n{3,}/g, '\n\n').trim();
  }

  // ---- Tree building: primary (File System Access API) ----

  async function buildTree(dirHandle, path, depth){
    const node = { name: dirHandle.name, kind:'directory', handle: dirHandle, path, children: [], depth };
    const entries = [];
    for await (const [name, handle] of dirHandle.entries()){
      entries.push([name, handle]);
    }
    entries.sort((a,b) => {
      if(a[1].kind !== b[1].kind) return a[1].kind === 'directory' ? -1 : 1;
      return a[0].localeCompare(b[0]);
    });
    for(const [name, handle] of entries){
      const childPath = path ? path + '/' + name : name;
      if(handle.kind === 'directory'){
        const childNode = await buildTree(handle, childPath, depth + 1);
        childNode.parentHandle = dirHandle;
        node.children.push(childNode);
      } else {
        const fileNode = { name, kind:'file', handle, path: childPath, parentHandle: dirHandle, depth: depth + 1 };
        node.children.push(fileNode);
      }
    }
    return node;
  }

  function buildTreeFromFileList(fileList){
    const files = Array.from(fileList).sort((a,b) => a.webkitRelativePath.localeCompare(b.webkitRelativePath));
    let rootName = '(selected folder)';
    const root = { name: rootName, kind:'directory', path:'', children:[], depth:0 };
    const dirIndex = { '': root };

    files.forEach(file => {
      const parts = file.webkitRelativePath.split('/');
      rootName = parts[0] || rootName;
      const relParts = parts.slice(1);
      if(!relParts.length) return;
      let currentPath = '';
      let parent = root;
      for(let i = 0; i < relParts.length - 1; i++){
        const dirName = relParts[i];
        currentPath = currentPath ? currentPath + '/' + dirName : dirName;
        if(!dirIndex[currentPath]){
          const node = { name: dirName, kind:'directory', path: currentPath, children: [], depth: i + 1 };
          dirIndex[currentPath] = node;
          parent.children.push(node);
        }
        parent = dirIndex[currentPath];
      }
      const fileName = relParts[relParts.length - 1];
      const filePath = currentPath ? currentPath + '/' + fileName : fileName;
      parent.children.push({
        name: fileName,
        kind: 'file',
        path: filePath,
        depth: relParts.length,
        handle: { getFile: async () => file }
      });
    });

    root.name = rootName;
    sortDirChildren(root);
    return root;
  }

  function sortDirChildren(node){
    node.children.sort((a,b) => {
      if(a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(c => { if(c.kind === 'directory') sortDirChildren(c); });
  }

  function downloadTextFile(filename, content){
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---- Shared rendering / indexing (works for either tree source) ----

  function indexNodes(node){
    nodesByPath[node.path] = node;
    if(node.kind === 'directory'){
      node.children.forEach(indexNodes);
    }
  }

  function renderNode(node){
    if(node.kind === 'directory'){
      const cls = node.depth > 0 ? (node.depth % 2 === 0 ? 'dir-node depth-sub' : 'dir-node') : 'dir-node';
      const kids = node.children.map(renderNode).join('');
      const body = kids || '<p class="empty-tree" style="margin-left:28px;">Empty</p>';
      return '<details class="' + cls + '" open><summary class="dir-summary">' + esc(node.name) + '</summary>' + body + '</details>';
    }
    return '<div class="file-row" data-path="' + esc(node.path) + '">' +
      '<span class="tree-name">' + esc(node.name) + '</span>' +
      '<button class="btn secondary tiny" data-action="view" data-path="' + esc(node.path) + '">View</button>' +
      '</div>';
  }

  function flattenDirs(node, acc){
    acc.push(node);
    node.children.forEach(c => { if(c.kind === 'directory') flattenDirs(c, acc); });
    return acc;
  }

  function flattenFiles(node, acc){
    node.children.forEach(c => {
      if(c.kind === 'file') acc.push(c);
      else flattenFiles(c, acc);
    });
    return acc;
  }

  function refreshTargetDirSelect(){
    const dirs = flattenDirs(rootNode, []);
    targetDirSelect.innerHTML = dirs.map(d =>
      '<option value="' + esc(d.path) + '">' + esc(d.path || '(root)') + '</option>'
    ).join('');
  }

  async function refreshTree(){
    rootNode = await buildTree(rootHandle, '', 0);
    nodesByPath = {};
    indexNodes(rootNode);
    treeContainer.innerHTML = renderNode(rootNode) || '<p class="empty-tree">This ' + NOUN + ' is empty.</p>';
    refreshTargetDirSelect();
  }

  // ---- Folder/directory selection ----

  pickBtn.addEventListener('click', async () => {
    if(fallbackMode){
      folderInputFallback.value = '';
      folderInputFallback.click();
      return;
    }
    try{
      // Selecting via the native picker already grants read access — no extra
      // permission dialog needed just to browse. Write access is requested later,
      // only when the user actually tries to create or delete a file.
      const handle = await window.showDirectoryPicker();
      hasWritePermission = false;
      await loadDirectory(handle);
    } catch(err){
      if(err.name !== 'AbortError') log('Unable to open ' + NOUN + ' selection dialog: ' + err.message, 'error');
    }
  });

  if(reconnectBtn){
    reconnectBtn.addEventListener('click', async () => {
      const handle = await loadSavedHandle();
      if(!handle){
        reconnectBtn.style.display = 'none';
        return;
      }
      try{
        // Single click, single native dialog — no need to re-navigate the OS folder picker.
        const perm = await handle.requestPermission({ mode:'read' });
        if(perm !== 'granted'){
          log('Permission to reconnect was not granted.', 'error');
          return;
        }
        hasWritePermission = false;
        await loadDirectory(handle, { silent: true });
      } catch(err){
        log('Unable to reconnect: ' + err.message, 'error');
      }
    });
  }

  if(forgetBtn){
    forgetBtn.addEventListener('click', async () => {
      await forgetSavedHandle();
      forgetBtn.style.display = 'none';
      log('Forgot the remembered ' + NOUN + '. You\'ll need to select it again next time.', 'info');
    });
  }

  // On load, see if we already know about a previously picked directory. If the
  // browser still has permission on file, this reconnects with zero dialogs;
  // otherwise it surfaces a one-click "Reconnect" option instead of hiding it.
  (async function tryAutoReconnect(){
    if(fallbackMode || (!supportsFSA)) return;
    const handle = await loadSavedHandle();
    if(!handle) return;
    try{
      const already = await handle.queryPermission({ mode:'read' });
      if(already === 'granted'){
        hasWritePermission = (await handle.queryPermission({ mode:'readwrite' })) === 'granted';
        await loadDirectory(handle, { silent: true });
      } else if(reconnectBtn){
        reconnectBtn.style.display = 'inline-block';
        reconnectBtn.textContent = 'Reconnect to "' + handle.name + '"';
      }
    } catch(e){ /* handle no longer valid (e.g. folder moved/deleted) — ignore */ }
  })();

  if(folderInputFallback){
    folderInputFallback.addEventListener('change', () => {
      const fileList = folderInputFallback.files;
      if(!fileList || !fileList.length){
        log('No files were found in that ' + NOUN + '.', 'error');
        return;
      }
      resetDirectoryState();
      rootNode = buildTreeFromFileList(fileList);
      nodesByPath = {};
      indexNodes(rootNode);
      rootPathLabel.innerHTML = NOUN_CAP + ': <b>' + esc(rootNode.name) + '</b>';
      treeContainer.innerHTML = renderNode(rootNode) || '<p class="empty-tree">This ' + NOUN + ' is empty.</p>';
      log(NOUN_CAP + ' selected: ' + rootNode.name + ' — ' + fileList.length + ' file(s) loaded in read-only preview mode.', 'success');
    });
  }

  treeContainer.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if(!btn) return;
    const path = btn.dataset.path;
    const node = nodesByPath[path];
    if(!node) return;
    if(btn.dataset.action === 'view') await viewFile(node);
    else if(btn.dataset.action === 'close') closePreview();
  });

  function setRowButtonState(path, isOpen){
    const btn = document.querySelector('.file-row [data-action][data-path="' + CSS.escape(path) + '"]');
    if(!btn) return;
    btn.dataset.action = isOpen ? 'close' : 'view';
    btn.textContent = isOpen ? 'Close' : 'View';
  }

  function closePreview(){
    if(activeFilePath) setRowButtonState(activeFilePath, false);
    previewMeta.textContent = 'No file selected.';
    previewGutter.style.display = 'none';
    previewGutter.textContent = '';
    previewCode.textContent = '';
    deleteBtn.style.display = 'none';
    document.querySelectorAll('.file-row').forEach(r => r.classList.remove('active'));
    activeFilePath = null;
  }

  async function viewFile(node){
    try{
      const file = await node.handle.getFile();
      const rawText = await file.text();
      const text = isRtf(node.name) ? stripRtf(rawText) : rawText;
      if(activeFilePath && activeFilePath !== node.path) setRowButtonState(activeFilePath, false);
      activeFilePath = node.path;
      previewMeta.textContent = node.path + '  ·  ' + file.size + ' bytes';
      if(text){
        const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
        const lines = trimmed.split('\n');
        if(lines.length > 1){
          previewGutter.style.display = '';
          previewGutter.textContent = lines.map((_, i) => i + 1).join('\n');
        } else {
          previewGutter.style.display = 'none';
          previewGutter.textContent = '';
        }
        previewCode.textContent = trimmed;
      } else {
        previewGutter.style.display = 'none';
        previewGutter.textContent = '';
        previewCode.textContent = '(empty file)';
      }
      deleteBtn.style.display = fallbackMode ? 'none' : 'inline-block';
      document.querySelectorAll('.file-row').forEach(r => r.classList.remove('active'));
      const row = document.querySelector('.file-row[data-path="' + CSS.escape(node.path) + '"]');
      if(row) row.classList.add('active');
      setRowButtonState(node.path, true);
      log('Opened: ' + node.path, 'info');
    } catch(err){
      log('Unable to read file "' + node.path + '": ' + err.message, 'error');
    }
  }

  deleteBtn.addEventListener('click', async () => {
    if(fallbackMode || !activeFilePath) return;
    const node = nodesByPath[activeFilePath];
    if(!node) return;
    const ok = confirm('Delete "' + node.path + '"? This action cannot be undone.');
    if(!ok){
      log('Deletion cancelled.', 'info');
      return;
    }
    if(!hasWritePermission && !(await ensureWritePermission(rootHandle))){
      log('Write permission was not granted, so the file could not be deleted.', 'error');
      return;
    }
    try{
      await node.parentHandle.removeEntry(node.name);
      log('File deleted: ' + node.path, 'success');
      previewMeta.textContent = 'No file selected.';
      previewGutter.style.display = 'none';
      previewGutter.textContent = '';
      previewCode.textContent = '';
      deleteBtn.style.display = 'none';
      activeFilePath = null;
      await refreshTree();
    } catch(err){
      log('Unable to delete file "' + node.path + '": ' + err.message, 'error');
    }
  });

  extSelect.addEventListener('change', () => {
    extCustom.style.display = extSelect.value === '__other' ? 'block' : 'none';
  });

  createBtn.addEventListener('click', async () => {
    const filename = document.getElementById('newFileName').value.trim();
    if(!filename){ log('Please enter a file name.', 'error'); return; }
    let ext = extSelect.value;
    if(ext === '__other'){
      ext = extCustom.value.trim().replace(/^\./,'');
      if(!ext){ log('No custom extension provided; defaulting to txt.', 'info'); ext = 'txt'; }
    }
    const fullName = filename + '.' + ext;
    const content = document.getElementById('newFileContent').value;

    if(fallbackMode){
      downloadTextFile(fullName, content);
      log('Downloaded "' + fullName + '" — this browser can\'t write directly into the selected ' + NOUN + ', so check your downloads.', 'success');
      document.getElementById('newFileName').value = '';
      document.getElementById('newFileContent').value = '';
      return;
    }

    if(!rootNode){ log('Please select a ' + NOUN + ' first.', 'error'); return; }
    if(!hasWritePermission && !(await ensureWritePermission(rootHandle))){
      log('Write permission was not granted, so the file could not be created.', 'error');
      return;
    }
    const dirPath = targetDirSelect.value;
    const dirNode = dirPath === '' ? rootNode : nodesByPath[dirPath];

    try{
      let exists = true;
      try{ await dirNode.handle.getFileHandle(fullName, { create:false }); }
      catch(e){ exists = false; }
      if(exists){ log('A file named "' + fullName + '" already exists.', 'error'); return; }

      const fileHandle = await dirNode.handle.getFileHandle(fullName, { create:true });
      const writable = await fileHandle.createWritable();
      await writable.write(content);
      await writable.close();
      log('File created: "' + fullName + '" in ' + (dirPath || '(root)') + '.', 'success');
      document.getElementById('newFileName').value = '';
      document.getElementById('newFileContent').value = '';
      await refreshTree();
    } catch(err){
      log('Unable to create file: ' + err.message, 'error');
    }
  });

  document.getElementById('nameSearchBtn').addEventListener('click', () => {
    if(!rootNode){ log('Please select a ' + NOUN + ' first.', 'error'); return; }
    const term = document.getElementById('nameSearch').value.trim().toLowerCase();
    if(!term){ log('Please enter a filename to search for.', 'error'); return; }
    const files = flattenFiles(rootNode, []);
    const matches = files.filter(f => f.name.toLowerCase().includes(term));
    if(matches.length){
      log('Files matching "' + term + '":', 'success');
      matches.forEach(m => log(m.path, 'success'));
    } else {
      log('No matching files were found for "' + term + '".', 'info');
    }
  });

  document.getElementById('contentSearchBtn').addEventListener('click', async () => {
    if(!rootNode){ log('Please select a ' + NOUN + ' first.', 'error'); return; }
    const raw = document.getElementById('contentSearch').value;
    const keywords = raw.split(';').map(k => k.trim()).filter(Boolean);
    if(!keywords.length){ log('Please enter one or more keywords, separated by semicolons.', 'error'); return; }
    const files = flattenFiles(rootNode, []);
    log('Searching ' + files.length + ' file(s) for: ' + keywords.join(', ') + ' …', 'info');
    const sequential = shouldReadSequentially();
    if(sequential) log('Low memory detected — reading files one at a time.', 'info');
    const t0 = performance.now();

    // Read files with several in flight at once (faster than one-at-a-time), but
    // never hold onto the text after checking it — keeps memory flat regardless
    // of how many/how large the files are. On low-memory devices, fall back to
    // the old sequential approach instead.
    const found = [];
    if(sequential){
      for(const f of files){
        const text = await readFileText(f);
        const match = matchFile(f, text, keywords);
        if(match) found.push(match);
      }
    } else {
      await mapWithConcurrency(files, 16, async (f) => {
        const text = await readFileText(f);
        const match = matchFile(f, text, keywords);
        if(match) found.push(match);
      });
    }
    const elapsed = Math.round(performance.now() - t0);
    log('Read ' + files.length + ' file(s) in ' + elapsed + 'ms.', 'info');
    found.sort((a, b) => a.path.localeCompare(b.path));
    if(found.length){
      log('Matches found in the following files:', 'success');
      found.forEach(m => {
        log(m.path, 'success');
        keywords.forEach(k => {
          const items = m.lineHits[k].map(n => '<li>' + n + '</li>').join('');
          logHtml('&nbsp;&nbsp;' + esc(k) + ' — Found at line:<ul style="margin:4px 0 8px 24px;padding:0;">' + items + '</ul>', 'success');
        });
      });
    } else {
      log('No matches were found.', 'info');
    }
  });
})();
