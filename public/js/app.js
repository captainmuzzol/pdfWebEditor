document.addEventListener('DOMContentLoaded', () => {
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const singleFileInput = document.getElementById('single-file-input');
    const fileGrid = document.getElementById('file-grid');
    const mergeBtn = document.getElementById('merge-btn');
    const selectAllBtn = document.getElementById('select-all-btn');
    const clearSelectedBtn = document.getElementById('clear-selected-btn');
    const reverseSortBtn = document.getElementById('reverse-sort');
    const autoDeleteChk = document.getElementById('auto-delete-after-export');
    const spinner = document.getElementById('loading-spinner');
    const rotationMap = new Map();

    function supportsWorker() {
        try {
            const blob = new Blob([''], { type: 'application/javascript' });
            const url = URL.createObjectURL(blob);
            const w = new Worker(url);
            w.terminate();
            URL.revokeObjectURL(url);
            return true;
        } catch (e) {
            return false;
        }
    }

    if (!supportsWorker()) {
        try { pdfjsLib.disableWorker = true; } catch (e) { }
    }

    async function getPdfDocument(url) {
        try {
            return await pdfjsLib.getDocument({ url }).promise;
        } catch (e1) {
            try {
                return await pdfjsLib.getDocument({ url, disableRange: true, disableStream: true, nativeImageDecoderSupport: 'none' }).promise;
            } catch (e2) {
                try {
                    const res = await fetch(url);
                    const buf = await res.arrayBuffer();
                    return await pdfjsLib.getDocument({ data: buf, disableFontFace: true, nativeImageDecoderSupport: 'none' }).promise;
                } catch (e3) {
                    throw e3;
                }
            }
        }
    }

    // Initialize Sortable
    new Sortable(fileGrid, {
        animation: 150,
        ghostClass: 'sortable-ghost',
        onEnd: updateMergeButtonState
    });

    async function initDeletedPages() {
        try {
            const res = await fetch('/state');
            if (res.ok) {
                const data = await res.json();
                if (data && data.success && data.deletedPages) {
                    window.__DELETED_PAGES__ = data.deletedPages;
                }
            }
        } catch (e) { }
    }

    // Handle existing files (SSR) by auto-expanding into page items
    (async function () {
        await initDeletedPages();
        const items = Array.from(document.querySelectorAll('.file-item'));
        for (const item of items) {
            const filename = item.dataset.id;
            const url = item.dataset.url;
            if (!filename || !url) continue;
            try {
                const nameEl = item.querySelector('.file-name');
                const originalName = nameEl ? nameEl.textContent : '';
                const index = Array.from(fileGrid.children).indexOf(item);
                const loadingTask = pdfjsLib.getDocument(url);
                const pdf = await loadingTask.promise;
                const totalPages = pdf.numPages;
                const fragment = document.createDocumentFragment();
                const delMap = (window.__DELETED_PAGES__ || {});
                const delList = Array.isArray(delMap[filename]) ? delMap[filename].map(n => parseInt(n, 10)) : [];
                for (let i = 1; i <= totalPages; i++) {
                    if (delList.includes(i)) continue;
                    const pageItem = document.createElement('div');
                    pageItem.className = 'file-item';
                    pageItem.dataset.source = filename;
                    pageItem.dataset.page = String(i);
                    pageItem.dataset.url = url;
                    pageItem.innerHTML = `
                        <div class="checkbox-container">
                            <input type="checkbox" class="file-checkbox">
                        </div>
                        <div class="rotate-btn">旋转</div>
                        <div class="thumbnail-container">
                            <span style="color: #999; font-size: 12px;">生成中...</span>
                        </div>
                        <div class="file-name" title="${originalName} - 第 ${i} 页">${originalName} - 第 ${i} 页</div>
                    `;
                    fragment.appendChild(pageItem);
                    setInitialRotation(pageItem);
                    generateThumbnail(pageItem, url, i, getRotationForItem(pageItem));
                }
                fileGrid.insertBefore(fragment, fileGrid.children[index + 1] || null);
                fileGrid.removeChild(item);
            } catch (e) {
                console.error('Error expanding SSR file into pages', e);
                setInitialRotation(item);
                generateThumbnail(item, url, undefined, getRotationForItem(item));
            }
        }
        updateMergeButtonState();
    })();

    // Drag and Drop Events
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('dragover');
    });

    dropZone.addEventListener('drop', async (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');

        const items = e.dataTransfer.items;
        if (!items) {
            handleFiles(e.dataTransfer.files);
            return;
        }

        const filePromises = [];

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;

            if (entry) {
                if (entry.isFile) {
                    filePromises.push(getFileFromEntry(entry));
                } else if (entry.isDirectory) {
                    filePromises.push(scanDirectory(entry));
                }
            } else {
                // Fallback if no entry support
                const file = item.getAsFile();
                if (file) filePromises.push(Promise.resolve(file));
            }
        }

        try {
            const results = await Promise.all(filePromises);
            // Results is array of (File or Array of Files)
            const flatFiles = results.flat().filter(f => f != null);
            handleFiles(flatFiles);
        } catch (err) {
            console.error(err);
        }
    });

    function getFileFromEntry(entry) {
        return new Promise((resolve) => {
            entry.file((file) => resolve(file), (err) => resolve(null));
        });
    }

    function scanDirectory(dirEntry) {
        return new Promise((resolve) => {
            const dirReader = dirEntry.createReader();
            // We only read once. If >100 files, we might miss some. 
            // Correct way is to loop, but for this demo:
            dirReader.readEntries(async (entries) => {
                const promises = [];
                for (let i = 0; i < entries.length; i++) {
                    if (entries[i].isFile) {
                        promises.push(getFileFromEntry(entries[i]));
                    }
                    // Ignore subdirectories
                }
                const files = await Promise.all(promises);
                resolve(files);
            }, (err) => resolve([]));
        });
    }

    fileInput.addEventListener('change', (e) => {
        handleFiles(e.target.files);
    });

    singleFileInput.addEventListener('change', (e) => {
        handleFiles(e.target.files);
    });

    // File Handling
    async function handleFiles(fileList) {
        // Convert FileList to Array if needed
        const files = Array.isArray(fileList) ? fileList : Array.from(fileList);

        if (files.length === 0) return;

        showLoading(true);
        const formData = new FormData();
        let pdfCount = 0;

        // Filter for root directory PDFs only

        for (let i = 0; i < files.length; i++) {
            const file = files[i];

            // Check if PDF
            if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
                continue;
            }

            // For Input webkitdirectory, we check webkitRelativePath
            if (file.webkitRelativePath && file.webkitRelativePath.length > 0) {
                const parts = file.webkitRelativePath.split('/');
                if (parts.length > 2) continue;
            }

            formData.append('files', file);
            pdfCount++;
        }

        if (pdfCount === 0) {
            alert('未找到有效的PDF文件。');
            showLoading(false);
            return;
        }

        try {
            const response = await fetch('/upload', {
                method: 'POST',
                body: formData
            });

            const result = await response.json();
            if (result.success) {
                appendFilesToGrid(result.files);
            } else {
                alert('上传失败: ' + (result.message || '未知错误'));
            }
        } catch (error) {
            console.error('Error uploading files:', error);
            alert('上传文件出错，请重试。');
        } finally {
            showLoading(false);
            // Reset input
            fileInput.value = '';
            if (singleFileInput) singleFileInput.value = '';
        }
    }

    async function appendFilesToGrid(files) {
        for (const file of files) {
            try {
                const loadingTask = pdfjsLib.getDocument(file.url);
                const pdf = await loadingTask.promise;
                const totalPages = pdf.numPages;
                const fragment = document.createDocumentFragment();
                const delMap = (window.__DELETED_PAGES__ || {});
                const delList = Array.isArray(delMap[file.filename]) ? delMap[file.filename].map(n => parseInt(n, 10)) : [];
                for (let i = 1; i <= totalPages; i++) {
                    if (delList.includes(i)) continue;
                    const pageItem = document.createElement('div');
                    pageItem.className = 'file-item';
                    pageItem.dataset.source = file.filename;
                    pageItem.dataset.page = String(i);
                    pageItem.dataset.url = file.url;
                    pageItem.innerHTML = `
                        <div class="checkbox-container">
                            <input type="checkbox" class="file-checkbox">
                        </div>
                        <div class="rotate-btn">旋转</div>
                        <div class="thumbnail-container">
                            <span style="color: #999; font-size: 12px;">生成中...</span>
                        </div>
                        <div class="file-name" title="${file.originalname} - 第 ${i} 页">${file.originalname} - 第 ${i} 页</div>
                    `;
                    fragment.appendChild(pageItem);
                    setInitialRotation(pageItem);
                    generateThumbnail(pageItem, file.url, i, getRotationForItem(pageItem));
                }
                fileGrid.appendChild(fragment);
                updateMergeButtonState();
            } catch (e) {
                console.error('Error expanding uploaded file into pages', e);
            }
        }
    }

    // Thumbnail Generation
    async function generateThumbnail(container, url, pageNumber, rotationDeg) {
        try {
            const pdf = await getPdfDocument(url);
            const numPages = pdf.numPages;
            const page = await pdf.getPage(pageNumber || 1);
            const thumbContainer = container.querySelector('.thumbnail-container');
            const areaW = Math.max(180, thumbContainer.clientWidth || container.clientWidth || 200);
            const areaH = Math.max(180, thumbContainer.clientHeight || 220);
            const topH = areaH;
            const dpr = window.devicePixelRatio || 1;

            const rotation = (rotationDeg || 0);
            const baseViewport = page.getViewport({ scale: 1, rotation: rotation });
            // 仅显示上半视图，不再计算完整视图比例

            // 计算满足清晰度的放大比例：保证源图裁剪区域至少是目标输出的 4 倍像素
            const oversample = 4;
            const topOutW = Math.floor(areaW * dpr);
            const topOutH = Math.floor(topH * dpr);
            const reqByW = (topOutW * oversample) / baseViewport.width;
            const reqByH = (topOutH * oversample * 2) / baseViewport.height; // 乘以2，因为裁剪的是上半部分
            let scaleLarge = Math.max(reqByW, reqByH) * 1.2; // 额外再放大 20%
            // 上限保护，避免过度渲染导致内存问题
            scaleLarge = Math.min(scaleLarge, 6.0);

            // 高分辨率离屏渲染（上半视图），带回退保护
            let largeCanvas, largeCtx;
            try {
                const largeViewport = page.getViewport({ scale: scaleLarge * dpr, rotation: rotation });
                largeCanvas = document.createElement('canvas');
                largeCtx = largeCanvas.getContext('2d');
                largeCanvas.width = Math.floor(largeViewport.width);
                largeCanvas.height = Math.floor(largeViewport.height);
                await page.render({ canvasContext: largeCtx, viewport: largeViewport }).promise;
            } catch (e) {
                // 回退到较小比例，保证基本可用
                const fallbackScale = 3.0;
                const largeViewport = page.getViewport({ scale: fallbackScale * dpr, rotation: rotation });
                largeCanvas = document.createElement('canvas');
                largeCtx = largeCanvas.getContext('2d');
                largeCanvas.width = Math.floor(largeViewport.width);
                largeCanvas.height = Math.floor(largeViewport.height);
                await page.render({ canvasContext: largeCtx, viewport: largeViewport }).promise;
            }

            // 不再渲染完整视图（移除下半缩略图）

            // 顶部视图（裁剪上半部分，避免糊）
            const topCanvas = document.createElement('canvas');
            const topCtx = topCanvas.getContext('2d');
            topCanvas.width = Math.floor(areaW * dpr);
            topCanvas.height = Math.floor(topH * dpr);
            topCanvas.style.width = '100%';
            // 顶部视图禁用平滑，增强文字清晰度
            topCtx.imageSmoothingEnabled = false;
            const cropH = Math.floor(largeCanvas.height / 2); // 裁剪上半部分
            topCtx.drawImage(
                largeCanvas,
                0,
                0,
                largeCanvas.width,
                cropH,
                0,
                0,
                topCanvas.width,
                topCanvas.height
            );

            // 移除下半视图

            thumbContainer.innerHTML = '';
            thumbContainer.appendChild(topCanvas);
        } catch (error) {
            console.error('Error generating thumbnail:', error);
            const thumbContainer = container.querySelector('.thumbnail-container');
            thumbContainer.innerHTML = '<span style="color: red; font-size: 12px;">预览失败</span>';
        }
    }

    // Global Preview Function
    window.previewPDF = async function (url, initialPage, rotationDeg) {
        const modal = document.getElementById('preview-modal');
        const container = document.getElementById('modal-preview-container');
        const prevBtn = document.getElementById('prev-page');
        const nextBtn = document.getElementById('next-page');
        const pageInfo = document.getElementById('page-info');
        const renderAllBtn = document.getElementById('render-all');
        modal.style.display = 'block';
        container.innerHTML = '<div class="loader" style="display:block; margin: 50px auto;"></div>';

        try {
            const pdf = await getPdfDocument(url);
            let currentPage = initialPage || 1;
            const totalPages = pdf.numPages;

            pageInfo.textContent = `第 ${currentPage} / ${totalPages} 页`;

            async function renderPage(pageNumber) {
                const page = await pdf.getPage(pageNumber);
                const modalContent = modal.querySelector('.modal-content');
                const controls = modal.querySelector('.modal-controls');
                const baseViewport = page.getViewport({ scale: 1, rotation: (rotationDeg || 0) });
                const maxWidth = (modalContent ? modalContent.clientWidth : container.clientWidth) - 40;
                const maxHeight = Math.floor(window.innerHeight * 0.8) - (controls ? controls.offsetHeight : 0) - 80;
                const fitScale = Math.max(0.5, Math.min(maxWidth / baseViewport.width, maxHeight / baseViewport.height));
                const viewport = page.getViewport({ scale: fitScale, rotation: (rotationDeg || 0) });
                const canvas = document.createElement('canvas');
                const context = canvas.getContext('2d');
                canvas.height = viewport.height;
                canvas.width = viewport.width;
                const renderContext = { canvasContext: context, viewport: viewport };
                await page.render(renderContext).promise;
                container.innerHTML = '';
                container.appendChild(canvas);
                pageInfo.textContent = `第 ${pageNumber} / ${totalPages} 页`;
                prevBtn.disabled = pageNumber <= 1;
                nextBtn.disabled = pageNumber >= totalPages;
            }

            prevBtn.onclick = function () {
                if (currentPage > 1) {
                    currentPage -= 1;
                    renderPage(currentPage);
                }
            };
            nextBtn.onclick = function () {
                if (currentPage < totalPages) {
                    currentPage += 1;
                    renderPage(currentPage);
                }
            };
            renderAllBtn.onclick = async function () {
                container.innerHTML = '';
                const filename = url.split('/').pop();
                for (let i = 1; i <= totalPages; i++) {
                    const page = await pdf.getPage(i);
                    const scale = 1.0;
                    const rot = getRotationByKey(`${filename}@${i}`) || 0;
                    const viewport = page.getViewport({ scale: scale, rotation: rot });
                    const canvas = document.createElement('canvas');
                    const context = canvas.getContext('2d');
                    canvas.height = viewport.height;
                    canvas.width = viewport.width;
                    const renderContext = { canvasContext: context, viewport: viewport };
                    await page.render(renderContext).promise;
                    container.appendChild(canvas);
                }
            };

            await renderPage(currentPage);
        } catch (error) {
            container.innerHTML = '<p>加载预览出错。</p>';
        }
    };

    // UI Controls
    fileGrid.addEventListener('change', (e) => {
        if (e.target.classList.contains('file-checkbox')) {
            updateMergeButtonState();
        }
    });

    selectAllBtn.addEventListener('click', () => {
        const checkboxes = document.querySelectorAll('.file-checkbox');
        const allChecked = Array.from(checkboxes).every(cb => cb.checked);
        checkboxes.forEach(cb => cb.checked = !allChecked);
        updateMergeButtonState();
    });

    fileGrid.addEventListener('click', async (e) => {
        const rotate = e.target.classList.contains('rotate-btn');
        const thumb = e.target.closest('.thumbnail-container');
        if (rotate) {
            const item = e.target.closest('.file-item');
            const key = getRotationKey(item);
            const current = rotationMap.get(key) || 0;
            const next = (current + 90) % 360;
            rotationMap.set(key, next);
            generateThumbnail(item, item.dataset.url, item.dataset.page ? parseInt(item.dataset.page, 10) : undefined, next);
            return;
        }
        if (thumb) {
            const item = thumb.closest('.file-item');
            const url = item.dataset.url;
            const rotationDeg = getRotationForItem(item);
            const page = item.dataset.page ? parseInt(item.dataset.page, 10) : undefined;
            window.previewPDF(url, page, rotationDeg);
        }
    });



    function updateMergeButtonState() {
        const checkedCount = document.querySelectorAll('.file-checkbox:checked').length;
        mergeBtn.disabled = checkedCount < 1;
        mergeBtn.innerText = checkedCount > 0 ? `合并导出 ${checkedCount} 个条目` : '合并导出选中条目';
    }

    if (clearSelectedBtn) {
        clearSelectedBtn.addEventListener('click', async () => {
            const allItems = Array.from(fileGrid.querySelectorAll('.file-item'));
            const selected = allItems.filter(it => {
                const cb = it.querySelector('.file-checkbox');
                return cb && cb.checked;
            });
            if (selected.length === 0) {
                alert('未选择任何条目');
                return;
            }
            const pageItems = selected.filter(it => it.dataset.page);
            const fileItems = selected.filter(it => it.dataset.id && !it.dataset.page);
            if (pageItems.length > 0) {
                try {
                    const payload = pageItems.map(it => ({ filename: it.dataset.source, page: parseInt(it.dataset.page, 10) }));
                    await fetch('/clear-pages', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ pages: payload })
                    });
                    const delMap = (window.__DELETED_PAGES__ = window.__DELETED_PAGES__ || {});
                    payload.forEach(p => {
                        const list = Array.isArray(delMap[p.filename]) ? delMap[p.filename] : [];
                        if (!list.includes(p.page)) list.push(p.page);
                        delMap[p.filename] = list;
                    });
                } catch (e) { }
                pageItems.forEach(it => it.remove());
            }
            if (fileItems.length > 0) {
                const ids = fileItems.map(it => it.dataset.id);
                try {
                    const response = await fetch('/clear-selected', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ fileIds: ids })
                    });
                    if (response.ok) {
                        fileItems.forEach(it => it.remove());
                    }
                } catch (error) {
                    console.error('Error clearing selected files:', error);
                }
            }
            updateMergeButtonState();
        });
    }

    if (reverseSortBtn) {
        reverseSortBtn.addEventListener('click', () => {
            const nodes = Array.from(fileGrid.children);
            nodes.reverse().forEach(n => fileGrid.appendChild(n));
            updateMergeButtonState();
        });
    }

    // Merge Functionality
    mergeBtn.addEventListener('click', async () => {
        async function buildPageItemsFromSelection() {
            const items = [];
            const fullFileIds = [];
            const nodes = Array.from(fileGrid.querySelectorAll('.file-item'));
            for (let i = 0; i < nodes.length; i++) {
                const item = nodes[i];
                const checkbox = item.querySelector('.file-checkbox');
                if (!checkbox || !checkbox.checked) continue;
                const page = item.dataset.page;
                const source = item.dataset.source;
                if (page && source) {
                    const rot = getRotationForItem(item);
                    items.push({ filename: source, page: parseInt(page, 10), rotate: rot });
                } else if (item.dataset.id) {
                    const url = item.dataset.url;
                    const loadingTask = pdfjsLib.getDocument(url);
                    const pdf = await loadingTask.promise;
                    const totalPages = pdf.numPages;
                    for (let p = 1; p <= totalPages; p++) {
                        const rot = getRotationByKey(`${item.dataset.id}@${p}`) || 0;
                        items.push({ filename: item.dataset.id, page: p, rotate: rot });
                    }
                    fullFileIds.push(item.dataset.id);
                }
            }
            return { items, fullFileIds };
        }

        const { items: pageItems, fullFileIds } = await buildPageItemsFromSelection();
        if (pageItems.length < 1) return;

        showLoading(true);
        try {
            const response = await fetch('/merge', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pageItems })
            });

            if (response.ok) {
                const result = await response.json();
                if (result.success && result.downloadUrl) {
                    showRenameModal(result.downloadUrl, result.filename, { pageItems, fullFileIds });
                } else {
                    alert('合并失败: ' + (result.message || '未知错误'));
                }
            } else {
                alert('合并失败。');
            }
        } catch (error) {
            console.error('Error merging:', error);
            alert('合并文件出错。');
        } finally {
            showLoading(false);
        }
    });

    function showLoading(show) {
        spinner.style.display = show ? 'block' : 'none';
    }

    function showRenameModal(downloadUrl, defaultFilename, deletionPlan) {
        const modal = document.getElementById('rename-modal');
        const buttons = document.querySelectorAll('.template-btn');
        const timesInput = document.getElementById('rename-times');
        const extraInput = document.getElementById('rename-extra');
        const freeInput = document.getElementById('rename-free');
        const previewEl = document.getElementById('rename-preview');
        const timeBtn = document.getElementById('download-time');
        const renameBtn = document.getElementById('download-rename');

        let selectedTemplate = '';

        function buildName() {
            const free = (freeInput && freeInput.value ? freeInput.value : '').trim();
            if (free) {
                const name = free.replace(/\.pdf$/i, '').trim();
                previewEl.textContent = name || '未选择';
                return name || defaultFilename || `合并文件`;
            }
            const parts = [];
            if (selectedTemplate) parts.push(selectedTemplate);
            const tVal = parseInt(timesInput.value, 10);
            const t = isNaN(tVal) ? 0 : Math.max(0, tVal);
            if (t > 0) parts.push(`第${t}次`);
            const extra = (extraInput.value || '').trim();
            if (extra) parts.push(extra);
            const name = parts.join('-');
            previewEl.textContent = name || '未选择';
            return name || defaultFilename || `合并文件`;
        }

        buttons.forEach(b => {
            b.classList.remove('active');
            b.onclick = function () {
                buttons.forEach(x => x.classList.remove('active'));
                b.classList.add('active');
                selectedTemplate = b.dataset.value || '';
                buildName();
            };
        });
        timesInput.oninput = buildName;
        extraInput.oninput = buildName;
        if (freeInput) freeInput.oninput = buildName;
        buildName();

        timeBtn.onclick = function () {
            const now = new Date();
            const pad = (n) => String(n).padStart(2, '0');
            const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
            triggerDownload(downloadUrl, `${ts}.pdf`);
            modal.style.display = 'none';
        };
        renameBtn.onclick = async function () {
            const name = buildName() + '.pdf';
            triggerDownload(downloadUrl, name);
            if (autoDeleteChk && autoDeleteChk.checked && deletionPlan) {
                try {
                    const { pageItems, fullFileIds } = deletionPlan;
                    const pagesPayload = Array.isArray(pageItems) ? pageItems.map(pi => ({ filename: pi.filename, page: pi.page })) : [];
                    if (pagesPayload.length > 0) {
                        await fetch('/clear-pages', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ pages: pagesPayload })
                        });
                        const delMap = (window.__DELETED_PAGES__ = window.__DELETED_PAGES__ || {});
                        pagesPayload.forEach(p => {
                            const list = Array.isArray(delMap[p.filename]) ? delMap[p.filename] : [];
                            if (!list.includes(p.page)) list.push(p.page);
                            delMap[p.filename] = list;
                        });
                        const all = Array.from(fileGrid.querySelectorAll('.file-item'));
                        all.forEach(item => {
                            const page = item.dataset.page ? parseInt(item.dataset.page, 10) : null;
                            const source = item.dataset.source || null;
                            if (page && source) {
                                if (pagesPayload.find(pi => pi.filename === source && pi.page === page)) {
                                    item.remove();
                                }
                            }
                        });
                    }
                    if (Array.isArray(fullFileIds) && fullFileIds.length > 0) {
                        const resp = await fetch('/clear-selected', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ fileIds: fullFileIds })
                        });
                        if (resp.ok) {
                            const all = Array.from(fileGrid.querySelectorAll('.file-item'));
                            all.forEach(item => {
                                if (item.dataset.id && fullFileIds.includes(item.dataset.id)) item.remove();
                            });
                        }
                    }
                    updateMergeButtonState();
                } catch (e) {
                    console.error('auto delete after export failed', e);
                }
            }
            modal.style.display = 'none';
        };

        modal.style.display = 'block';
    }

    function triggerDownload(url, filename) {
        const href = url + `?name=${encodeURIComponent(filename)}`;
        const a = document.createElement('a');
        a.href = href;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }



    function getRotationKey(item) {
        const filename = item.dataset.source || item.dataset.id;
        const page = item.dataset.page ? parseInt(item.dataset.page, 10) : 1;
        return `${filename}@${page}`;
    }
    function getRotationByKey(key) {
        return rotationMap.get(key) || 0;
    }
    function getRotationForItem(item) {
        return rotationMap.get(getRotationKey(item)) || 0;
    }
    function setInitialRotation(item) {
        const key = getRotationKey(item);
        if (!rotationMap.has(key)) rotationMap.set(key, 0);
    }

    window.addEventListener('beforeunload', () => {
        try {
            if (navigator.sendBeacon) {
                navigator.sendBeacon('/clear');
            } else {
                fetch('/clear', { method: 'POST', keepalive: true });
            }
        } catch (e) { }
    });
});
