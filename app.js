/* Front-end orchestration: cropping, submission, status polling, and GLB download. */
(() => {
  const $ = (id) => document.getElementById(id);
  const fileInput = $('fileInput');
  const cameraInput = $('cameraInput');
  const cropImage = $('cropImage');
  const cropWrap = $('cropWrap');
  const uploadPlaceholder = $('uploadPlaceholder');
  const cropTools = $('cropTools');
  const imageReady = $('imageReady');
  const generateBtn = $('generateBtn');
  const viewerEmpty = $('viewerEmpty');
  const modelCanvas = $('modelCanvas');
  const viewerControls = $('viewerControls');
  const jobPanel = $('jobPanel');
  const progressFill = $('progressFill');
  const toast = $('toast');
  let cropper = null;
  let originalFile = null;
  let preparedBlob = null;
  let currentTaskId = null;
  let pollTimer = null;
  let accessKey = '';
  let accessRequired = false;
  let serverReady = false;
  let toastTimer = null;
  let preparedPreviewUrl = null;
  const API_BASE = (document.querySelector('meta[name="api-base"]')?.content || '').trim().replace(/\/+$/, '');
  const apiUrl = (path) => `${API_BASE}${path}`;

  function syncGenerateButton() {
    generateBtn.disabled = !preparedBlob || !serverReady || (accessRequired && !accessKey);
  }

  function notify(message, isError = false) {
    toast.textContent = message;
    toast.classList.toggle('error', isError);
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 3600);
  }

  async function api(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (accessKey) headers.set('X-Access-Key', accessKey);
    const response = await fetch(url, { ...options, headers });
    if (!response.ok) {
      let message = `تعذّر تنفيذ الطلب (${response.status})`;
      try {
        const data = await response.json();
        message = data.detail || data.message || message;
      } catch (_) {}
      throw new Error(message);
    }
    return response;
  }

  $('accessToggle').addEventListener('click', () => $('accessPanel').classList.toggle('hidden'));
  $('saveAccess').addEventListener('click', () => {
    accessKey = $('accessKey').value.trim();
    notify('تم تطبيق رمز الوصول في هذه الصفحة فقط.');
    checkHealth();
  });

  function stopCropper() {
    if (cropper) { cropper.destroy(); cropper = null; }
  }

  function loadFile(file) {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
      notify('اختر صورة PNG أو JPG أو WebP.', true); return;
    }
    if (file.size > 15 * 1024 * 1024) {
      notify('حجم الصورة يجب ألا يتجاوز 15 ميغابايت.', true); return;
    }
    originalFile = file;
    preparedBlob = null;
    if (preparedPreviewUrl) { URL.revokeObjectURL(preparedPreviewUrl); preparedPreviewUrl = null; }
    $('readyInfo').textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`;
    imageReady.classList.add('hidden');
    uploadPlaceholder.classList.add('hidden');
    cropWrap.classList.remove('hidden');
    cropTools.classList.remove('hidden');
    generateBtn.disabled = true;
    stopCropper();
    cropImage.onload = () => {
      stopCropper();
      cropper = new Cropper(cropImage, {
        viewMode: 1,
        dragMode: 'crop',
        autoCropArea: 0.82,
        responsive: true,
        restore: false,
        guides: true,
        center: true,
        highlight: true,
        background: false,
        movable: true,
        rotatable: true,
        scalable: false,
        zoomable: true,
        zoomOnTouch: true,
        zoomOnWheel: true,
        toggleDragModeOnDblclick: false,
        checkOrientation: true,
      });
    };
    cropImage.src = URL.createObjectURL(file);
  }

  fileInput.addEventListener('change', (e) => loadFile(e.target.files?.[0]));
  cameraInput.addEventListener('change', (e) => loadFile(e.target.files?.[0]));
  $('chooseBtn').addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
  $('cameraBtn').addEventListener('click', (e) => { e.stopPropagation(); cameraInput.click(); });
  $('changeImageBtn').addEventListener('click', () => fileInput.click());
  $('dropZone').addEventListener('click', (e) => {
    if (e.target.closest('button') || e.target.closest('.cropper-container')) return;
    if (!cropper) fileInput.click();
  });
  $('dropZone').addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && !cropper) { e.preventDefault(); fileInput.click(); }
  });
  ['dragenter', 'dragover'].forEach(type => $('dropZone').addEventListener(type, e => {
    e.preventDefault(); $('dropZone').classList.add('drag-over');
  }));
  ['dragleave', 'drop'].forEach(type => $('dropZone').addEventListener(type, e => {
    e.preventDefault(); $('dropZone').classList.remove('drag-over');
  }));
  $('dropZone').addEventListener('drop', e => loadFile(e.dataTransfer?.files?.[0]));

  $('rotateBtn').addEventListener('click', () => cropper?.rotate(90));
  $('resetCropBtn').addEventListener('click', () => cropper?.reset());
  $('applyCropBtn').addEventListener('click', () => {
    if (!cropper) return;
    const button = $('applyCropBtn');
    button.disabled = true;
    button.textContent = 'تجهيز الصورة…';
    try {
      const canvas = cropper.getCroppedCanvas({
        maxWidth: 2048, maxHeight: 2048,
        imageSmoothingEnabled: true, imageSmoothingQuality: 'high', fillColor: '#ffffff'
      });
      if (!canvas) throw new Error('تعذّر قص الصورة. أعد تحديد المنطقة.');
      canvas.toBlob(blob => {
        button.disabled = false; button.textContent = 'اعتماد القص';
        if (!blob) { notify('تعذّر تجهيز الصورة.', true); return; }
        preparedBlob = blob;
        if (preparedPreviewUrl) URL.revokeObjectURL(preparedPreviewUrl);
        preparedPreviewUrl = URL.createObjectURL(blob);
        $('readyThumbnail').src = preparedPreviewUrl;
        stopCropper();
        cropTools.classList.add('hidden');
        cropWrap.classList.add('hidden');
        uploadPlaceholder.classList.add('hidden');
        imageReady.classList.remove('hidden');
        $('readyInfo').textContent = `${canvas.width} × ${canvas.height} px · جاهزة للإرسال`;
        syncGenerateButton();
      }, 'image/png');
    } catch (err) {
      button.disabled = false; button.textContent = 'اعتماد القص';
      notify(err.message || 'تعذّر قص الصورة.', true);
    }
  });

  function updateJob(task) {
    jobPanel.classList.remove('hidden');
    $('jobTitle').textContent = task.stage === 'queued' ? 'في قائمة الانتظار'
      : task.stage === 'loading_model' ? 'تجهيز محرّك الذكاء الاصطناعي'
      : task.stage === 'preprocessing' ? 'تحضير الصورة'
      : task.stage === 'generating' ? 'النموذج ينشئ الشكل والخامة'
      : task.stage === 'exporting' ? 'تحويل النتيجة إلى GLB'
      : task.stage === 'completed' ? 'اكتمل التوليد'
      : task.stage === 'failed' ? 'لم تكتمل المهمة' : 'جارٍ التنفيذ';
    $('jobBadge').textContent = String(task.status || 'running').toUpperCase();
    $('jobMessage').textContent = task.message || '';
    $('jobPercent').textContent = task.indeterminate ? '…' : `${task.progress || 0}%`;
    progressFill.classList.toggle('indeterminate', Boolean(task.indeterminate));
    if (!task.indeterminate) progressFill.style.width = `${Math.max(2, Math.min(100, task.progress || 0))}%`;
    else progressFill.style.width = '34%';
    $('indeterminateNote').classList.toggle('hidden', !task.indeterminate);
    const pill = $('viewerStatus');
    pill.classList.toggle('ok', task.status === 'completed');
    pill.innerHTML = `<i></i>${task.status === 'completed' ? 'اكتمل التوليد' : task.status === 'failed' ? 'تعذّر التوليد' : 'قيد المعالجة'}`;
  }

  async function pollTask(taskId) {
    if (currentTaskId !== taskId) return;
    try {
      const response = await api(apiUrl(`/api/tasks/${taskId}`));
      const task = await response.json();
      updateJob(task);
      if (task.status === 'completed') {
        clearTimeout(pollTimer);
        $('resultActions').classList.remove('hidden');
        $('resultDetails').textContent = `GLB · خامات PBR · ${task.file_size ? (task.file_size / 1024 / 1024).toFixed(1) + ' MB' : ''}${task.elapsed_seconds ? ' · ' + task.elapsed_seconds + ' ثانية' : ''}`;
        $('viewerLoading').classList.remove('hidden');
        $('viewerLoadingTitle').textContent = 'تحميل المجسّم للمعاينة…';
        try {
          const fileResponse = await api(apiUrl(`/api/tasks/${taskId}/preview`));
          const blob = await fileResponse.blob();
          const url = URL.createObjectURL(blob);
          await window.ModelViewer.load(url);
          viewerEmpty.classList.add('hidden');
          modelCanvas.classList.remove('hidden');
          viewerControls.classList.remove('hidden');
          requestAnimationFrame(() => window.ModelViewer.resize?.());
        } catch (err) {
          notify(`تم الإنشاء، لكن المعاينة تعذّرت: ${err.message}`, true);
        } finally {
          $('viewerLoading').classList.add('hidden');
        }
        syncGenerateButton();
        generateBtn.querySelector('span:nth-child(2)').textContent = 'إنشاء نسخة جديدة';
        notify('اكتمل المجسّم بنجاح.');
        return;
      }
      if (task.status === 'failed') {
        clearTimeout(pollTimer);
        $('jobMessage').textContent = `${task.message || 'حدث خطأ.'}${task.error ? ' ' + task.error : ''}`;
        syncGenerateButton();
        notify('فشل التوليد. راجع رسالة المهمة وسجل الخادم.', true);
        return;
      }
      pollTimer = setTimeout(() => pollTask(taskId), 2200);
    } catch (err) {
      $('jobMessage').textContent = `انقطع الاتصال مؤقتاً: ${err.message}. ستتم إعادة المحاولة…`;
      pollTimer = setTimeout(() => pollTask(taskId), 4000);
    }
  }

  generateBtn.addEventListener('click', async () => {
    if (!preparedBlob) { notify('ارفع صورة واعتمد القص أولاً.', true); return; }
    generateBtn.disabled = true;
    generateBtn.querySelector('span:nth-child(2)').textContent = 'إرسال المهمة إلى GPU…';
    $('resultActions').classList.add('hidden');
    $('viewerControls').classList.add('hidden');
    $('modelCanvas').classList.add('hidden');
    $('viewerEmpty').classList.remove('hidden');
    $('viewerLoading').classList.add('hidden');
    $('viewerStatus').classList.remove('ok');
    $('viewerStatus').innerHTML = '<i></i> قيد المعالجة';
    if (window.ModelViewer) window.ModelViewer.clear();
    try {
      const form = new FormData();
      form.append('image', preparedBlob, 'reference.png');
      form.append('resolution', document.querySelector('input[name="resolution"]:checked').value);
      form.append('face_count', $('faceCount').value);
      form.append('texture_size', $('textureSize').value);
      const seed = $('seedInput').value.trim();
      form.append('seed', seed ? seed : '-1');
      const response = await api(apiUrl('/api/generate'), { method: 'POST', body: form });
      const data = await response.json();
      currentTaskId = data.task_id;
      updateJob({ status: 'queued', stage: 'queued', progress: 2, message: 'أُرسلت المهمة إلى الخادم.' });
      $('viewerLoading').classList.remove('hidden');
      $('viewerLoadingTitle').textContent = 'بانتظار بدء التوليد…';
      pollTask(currentTaskId);
    } catch (err) {
      syncGenerateButton();
      generateBtn.querySelector('span:nth-child(2)').textContent = 'إعادة المحاولة';
      notify(err.message, true);
    }
  });

  $('downloadBtn').addEventListener('click', async () => {
    if (!currentTaskId) return;
    const button = $('downloadBtn');
    const oldText = button.innerHTML;
    button.disabled = true; button.textContent = 'جاري تنزيل الملف…';
    try {
      const response = await api(apiUrl(`/api/tasks/${currentTaskId}/download`));
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = 'ai-3d-model.glb'; document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (err) { notify(err.message, true); }
    finally { button.disabled = false; button.innerHTML = oldText; }
  });

  $('resetViewBtn').addEventListener('click', () => window.ModelViewer?.reset());
  $('wireframeBtn').addEventListener('click', () => window.ModelViewer?.toggleWireframe());

  async function checkHealth() {
    const note = $('serverNote');
    try {
      const response = await fetch(apiUrl('/api/health')); 
      if (!response.ok) throw new Error('الخادم غير متاح');
      const health = await response.json();
      accessRequired = Boolean(health.access_key_required);
      serverReady = Boolean(health.cuda_available);
      if (accessRequired && !accessKey) {
        $('accessPanel').classList.remove('hidden');
        note.textContent = 'الخادم محمي؛ أدخل رمز الوصول من إعدادات الأعلى.';
        note.classList.remove('error');
      } else if (!serverReady) {
        note.textContent = 'اتصل بالخادم، لكن CUDA/GPU غير متاحة حالياً. لا يبدأ التوليد حتى يتوفر خادم NVIDIA GPU.';
        note.classList.add('error');
      } else {
        note.textContent = `الخادم جاهز${health.gpu_name ? ' · ' + health.gpu_name : ''}. النموذج يُحمّل عند أول مهمة.`;
        note.classList.remove('error');
      }
      syncGenerateButton();
    } catch (err) {
      note.textContent = 'واجهة الموقع تعمل، لكن خادم الذكاء الاصطناعي غير متصل. راجع تعليمات التشغيل والاستضافة.';
      note.classList.add('error');
      serverReady = false;
      syncGenerateButton();
    }
  }

  window.addEventListener('beforeunload', () => {
    stopCropper();
    if (preparedPreviewUrl) URL.revokeObjectURL(preparedPreviewUrl);
    if (pollTimer) clearTimeout(pollTimer);
  });
  checkHealth();
})();
