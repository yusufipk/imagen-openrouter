/**
 * Imagen - Internal AI Image Generation Tool
 * Supports multiple models via OpenRouter API
 */

// ===== IndexedDB Storage =====
const ImagenDB = {
    dbName: 'ImagenDB',
    storeName: 'images',
    db: null,

    async open() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve(this.db);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    const store = db.createObjectStore(this.storeName, { keyPath: 'id' });
                    store.createIndex('createdAt', 'createdAt', { unique: false });
                }
            };
        });
    },

    async saveImage(imageData) {
        await this.ensureOpen();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.put(imageData);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    },

    async getAllImages() {
        await this.ensureOpen();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const request = store.getAll();
            request.onsuccess = () => {
                // Sort by createdAt descending (newest first)
                const images = request.result.sort((a, b) =>
                    new Date(b.createdAt) - new Date(a.createdAt)
                );
                resolve(images);
            };
            request.onerror = () => reject(request.error);
        });
    },

    async deleteImage(id) {
        await this.ensureOpen();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    },

    async clearAll() {
        await this.ensureOpen();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.clear();
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    },

    async ensureOpen() {
        if (!this.db) {
            await this.open();
        }
    }
};

// ===== State Management =====
const state = {
    apiKey: localStorage.getItem('imagen_api_key') || '',
    selectedModel: localStorage.getItem('imagen_model') || 'google/gemini-2.5-flash-image',
    imageSize: '1024x1024',
    imageQuality: '1K',
    aspectRatio: '1:1',
    imageCount: 1,
    references: [], // Dynamic array - unlimited references
    images: [], // Will be loaded from IndexedDB
    currentImage: null,
    isGenerating: false
};

// ===== Model Configurations =====
const MODEL_CONFIGS = {
    'google/gemini-2.5-flash-image': {
        name: 'Gemini 2.5 Flash Image',
        supportsImageSize: true,
        supportsAspectRatio: true,
        supportsImageInput: true,
        maxReferences: 3
    },
    'google/gemini-2.5-flash-image-preview': {
        name: 'Gemini 2.5 Flash Image (Preview)',
        supportsImageSize: true,
        supportsAspectRatio: true,
        supportsImageInput: true,
        maxReferences: 3
    },
    'google/gemini-3-pro-image-preview': {
        name: 'Gemini 3 Pro Image (Preview)',
        supportsImageSize: true,
        supportsAspectRatio: true,
        supportsImageInput: true,
        maxReferences: 14
    },
    'openai/gpt-5-image': {
        name: 'GPT-5 Image',
        supportsImageSize: false,
        supportsAspectRatio: true,
        supportsImageInput: true,
        maxReferences: 1
    },
    'openai/gpt-5-image-mini': {
        name: 'GPT-5 Image Mini',
        supportsImageSize: false,
        supportsAspectRatio: true,
        supportsImageInput: true,
        maxReferences: 1
    },
    'black-forest-labs/flux.2-pro': {
        name: 'Flux 2 Pro',
        supportsImageSize: false,
        supportsAspectRatio: true,
        supportsImageInput: false,
        maxReferences: 0
    },
    'black-forest-labs/flux.2-max': {
        name: 'Flux 2 Max',
        supportsImageSize: false,
        supportsAspectRatio: true,
        supportsImageInput: false,
        maxReferences: 0
    },
    'black-forest-labs/flux.2-flex': {
        name: 'Flux 2 Flex',
        supportsImageSize: false,
        supportsAspectRatio: true,
        supportsImageInput: false,
        maxReferences: 0
    },
    'black-forest-labs/flux.2-klein-4b': {
        name: 'Flux 2 Klein 4B',
        supportsImageSize: false,
        supportsAspectRatio: true,
        supportsImageInput: false,
        maxReferences: 0
    },
    'bytedance-seed/seedream-4.5': {
        name: 'Seedream 4.5',
        supportsImageSize: false,
        supportsAspectRatio: true,
        supportsImageInput: false,
        maxReferences: 0
    },
    'sourceful/riverflow-v2-fast-preview': {
        name: 'Riverflow V2 Fast',
        supportsImageSize: false,
        supportsAspectRatio: true,
        supportsImageInput: false,
        maxReferences: 0
    },
    'sourceful/riverflow-v2-standard-preview': {
        name: 'Riverflow V2 Standard',
        supportsImageSize: false,
        supportsAspectRatio: true,
        supportsImageInput: false,
        maxReferences: 0
    },
    'sourceful/riverflow-v2-max-preview': {
        name: 'Riverflow V2 Max',
        supportsImageSize: false,
        supportsAspectRatio: true,
        supportsImageInput: false,
        maxReferences: 0
    }
};

// ===== DOM Elements =====
const elements = {
    // Sidebar
    modelSelectContainer: document.getElementById('modelSelectContainer'),
    modelSelectTrigger: document.getElementById('modelSelectTrigger'),
    modelSelectValue: document.getElementById('modelSelectValue'),
    modelSelectOptions: document.getElementById('modelSelectOptions'),
    geminiOptions: document.getElementById('geminiOptions'),
    apiKey: document.getElementById('apiKey'),
    saveApiKey: document.getElementById('saveApiKey'),
    imageCount: document.getElementById('imageCount'),
    decreaseCount: document.getElementById('decreaseCount'),
    increaseCount: document.getElementById('increaseCount'),
    clearReferences: document.getElementById('clearReferences'),
    referenceSlots: document.getElementById('referenceSlots'),

    // Main Content
    promptInput: document.getElementById('promptInput'),
    charCount: document.getElementById('charCount'),
    generateBtn: document.getElementById('generateBtn'),
    loadingContainer: document.getElementById('loadingContainer'),
    gallery: document.getElementById('gallery'),
    galleryEmpty: document.getElementById('galleryEmpty'),
    clearGallery: document.getElementById('clearGallery'),

    // Modal
    imageModal: document.getElementById('imageModal'),
    modalOverlay: document.getElementById('modalOverlay'),
    modalClose: document.getElementById('modalClose'),
    modalImage: document.getElementById('modalImage'),
    modalMetadata: document.getElementById('modalMetadata'),
    useAsReference: document.getElementById('useAsReference'),
    recreateImage: document.getElementById('recreateImage'),
    downloadImage: document.getElementById('downloadImage')
};

// ===== Initialization =====
async function init() {
    // Load saved API key
    if (state.apiKey) {
        elements.apiKey.value = state.apiKey;
    }

    // Render reference slots
    renderReferenceSlots();

    // Restore saved model selection
    if (state.selectedModel) {
        const savedOption = document.querySelector(`.custom-select-option[data-value="${state.selectedModel}"]`);
        if (savedOption) {
            document.querySelectorAll('.custom-select-option').forEach(o => o.classList.remove('selected'));
            savedOption.classList.add('selected');
            elements.modelSelectValue.textContent = savedOption.textContent;
        }
    }

    // Load images from IndexedDB
    try {
        state.images = await ImagenDB.getAllImages();
    } catch (error) {
        console.error('Failed to load images from IndexedDB:', error);
        state.images = [];
    }

    // Render gallery
    renderGallery();

    // Set up event listeners
    setupEventListeners();

    // Initialize UI state
    updateGeminiOptionsVisibility();
}

// ===== Event Listeners =====
function setupEventListeners() {
    // Custom dropdown - toggle
    elements.modelSelectTrigger.addEventListener('click', () => {
        elements.modelSelectContainer.classList.toggle('open');
    });

    // Custom dropdown - option selection
    document.querySelectorAll('.custom-select-option').forEach(option => {
        option.addEventListener('click', () => {
            state.selectedModel = option.dataset.value;
            localStorage.setItem('imagen_model', state.selectedModel);
            elements.modelSelectValue.textContent = option.textContent;
            document.querySelectorAll('.custom-select-option').forEach(o => o.classList.remove('selected'));
            option.classList.add('selected');
            elements.modelSelectContainer.classList.remove('open');
            updateGeminiOptionsVisibility();
        });
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!elements.modelSelectContainer.contains(e.target)) {
            elements.modelSelectContainer.classList.remove('open');
        }
    });

    // Size toggle buttons
    document.querySelectorAll('.btn-toggle').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.btn-toggle').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            state.imageSize = btn.dataset.size;
            state.imageQuality = btn.dataset.quality;
        });
    });

    // Aspect ratio buttons
    document.querySelectorAll('.btn-aspect').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.btn-aspect').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            state.aspectRatio = btn.dataset.ratio;
        });
    });

    // Image count
    if (elements.decreaseCount) {
        elements.decreaseCount.addEventListener('click', () => {
            if (state.imageCount > 1) {
                state.imageCount--;
                elements.imageCount.value = state.imageCount;
            }
        });
    }

    if (elements.increaseCount) {
        elements.increaseCount.addEventListener('click', () => {
            if (state.imageCount < 8) {
                state.imageCount++;
                elements.imageCount.value = state.imageCount;
            }
        });
    }

    if (elements.imageCount) {
        elements.imageCount.addEventListener('change', (e) => {
            let val = parseInt(e.target.value);
            if (isNaN(val) || val < 1) val = 1;
            if (val > 8) val = 8;
            state.imageCount = val;
            elements.imageCount.value = val;
        });
    }

    // API Key
    elements.saveApiKey.addEventListener('click', () => {
        state.apiKey = elements.apiKey.value.trim();
        localStorage.setItem('imagen_api_key', state.apiKey);
        showToast('API key saved!', 'success');
    });

    // Reference images are handled by renderReferenceSlots()
    elements.clearReferences.addEventListener('click', clearAllReferences);

    // Drag & Drop for reference images
    setupDragAndDrop();

    // Prompt input
    elements.promptInput.addEventListener('input', () => {
        elements.charCount.textContent = `${elements.promptInput.value.length} chars`;
    });

    // Generate button
    elements.generateBtn.addEventListener('click', generateImages);

    // Clear gallery
    elements.clearGallery.addEventListener('click', async () => {
        if (confirm('Are you sure you want to clear all generated images?')) {
            state.images = [];
            try {
                await ImagenDB.clearAll();
            } catch (e) {
                console.warn('Could not clear IndexedDB:', e);
            }
            renderGallery();
            showToast('Gallery cleared', 'success');
        }
    });

    // Modal
    elements.modalOverlay.addEventListener('click', closeModal);
    elements.modalClose.addEventListener('click', closeModal);
    elements.useAsReference.addEventListener('click', useImageAsReference);
    elements.recreateImage.addEventListener('click', recreateImage);
    elements.downloadImage.addEventListener('click', downloadCurrentImage);

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeModal();
        if (e.key === 'Enter' && e.ctrlKey) generateImages();
    });
}

// ===== Drag & Drop =====
function setupDragAndDrop() {
    const dropZone = elements.referenceSlots;

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, preventDefaults, false);
        document.body.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => {
            dropZone.classList.add('drag-over');
        }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => {
            dropZone.classList.remove('drag-over');
        }, false);
    });

    dropZone.addEventListener('drop', handleDrop, false);
}

function handleDrop(e) {
    const dt = e.dataTransfer;
    const files = dt.files;

    [...files].forEach(file => {
        if (file.type.startsWith('image/')) {
            const reader = new FileReader();
            reader.onload = (event) => {
                state.references.push(event.target.result);
                renderReferenceSlots();
            };
            reader.readAsDataURL(file);
        }
    });

    if (files.length > 0) {
        showToast(`${files.length} image(s) added as reference`, 'success');
    }
}

// ===== Reference Image Handling =====
function handleReferenceUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
        state.references.push(event.target.result);
        renderReferenceSlots();
    };
    reader.readAsDataURL(file);

    // Reset the input so the same file can be selected again
    e.target.value = '';
}

function renderReferenceSlots() {
    const container = document.getElementById('referenceSlots');
    container.innerHTML = '';

    // Render existing references
    state.references.forEach((ref, index) => {
        const slot = document.createElement('div');
        slot.className = 'reference-slot filled';
        slot.dataset.slot = index;
        slot.innerHTML = `
            <img src="${ref}" alt="Reference ${index + 1}">
            <button class="remove-ref" data-index="${index}">×</button>
        `;
        container.appendChild(slot);
    });

    // Add "Add new" slot
    const addSlot = document.createElement('div');
    addSlot.className = 'reference-slot empty add-new';
    addSlot.innerHTML = `
        <span class="slot-label">+ Add</span>
        <input type="file" accept="image/*" class="reference-input" id="addReferenceInput">
    `;
    container.appendChild(addSlot);

    // Attach event listeners
    container.querySelectorAll('.remove-ref').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const index = parseInt(btn.dataset.index);
            removeReference(index);
        });
    });

    const addInput = container.querySelector('#addReferenceInput');
    if (addInput) {
        addInput.addEventListener('change', handleReferenceUpload);
    }
}

function removeReference(index) {
    state.references.splice(index, 1);
    renderReferenceSlots();
}

function clearAllReferences() {
    state.references = [];
    renderReferenceSlots();
    showToast('References cleared', 'success');
}

// ===== Image Generation =====
async function generateImages() {
    const prompt = elements.promptInput.value.trim();

    if (!prompt) {
        showToast('Please enter a prompt', 'warning');
        return;
    }

    if (!state.apiKey) {
        showToast('Please enter your OpenRouter API key', 'error');
        return;
    }

    state.isGenerating = true;
    elements.generateBtn.disabled = true;
    elements.loadingContainer.style.display = 'flex';

    try {
        const modelConfig = MODEL_CONFIGS[state.selectedModel];
        const promises = [];

        for (let i = 0; i < state.imageCount; i++) {
            promises.push(generateSingleImage(prompt, modelConfig));
        }

        const results = await Promise.allSettled(promises);

        let successCount = 0;
        const newImages = [];

        results.forEach((result, index) => {
            if (result.status === 'fulfilled' && result.value) {
                const imageData = {
                    id: Date.now() + index,
                    url: result.value,
                    prompt: prompt,
                    model: state.selectedModel,
                    modelName: modelConfig.name,
                    size: state.imageSize,
                    quality: state.imageQuality,
                    aspectRatio: state.aspectRatio,
                    references: state.references.length > 0 ? [...state.references] : [],
                    createdAt: new Date().toISOString()
                };
                newImages.push(imageData);
                state.images.unshift(imageData);
                successCount++;
            } else {
                console.error('Failed to generate image:', result.reason);
            }
        });

        if (successCount > 0) {
            // Render gallery immediately so user sees results
            renderGallery();
            showToast(`${successCount} image(s) generated!`, 'success');
            
            // Save to IndexedDB in background (don't block UI)
            Promise.all(newImages.map(img => ImagenDB.saveImage(img)))
                .catch(dbError => console.error('Failed to save to IndexedDB:', dbError));
        } else {
            showToast('Failed to generate images. Check console for details.', 'error');
        }

    } catch (error) {
        console.error('Generation error:', error);
        showToast(`Error: ${error.message}`, 'error');
    } finally {
        state.isGenerating = false;
        elements.generateBtn.disabled = false;
        elements.loadingContainer.style.display = 'none';
    }
}

async function generateSingleImage(prompt, modelConfig) {
    // Build message content
    const content = [];

    // Add reference images if supported
    if (modelConfig.supportsImageInput) {
        state.references.forEach((ref, index) => {
            if (ref) {
                content.push({
                    type: 'image_url',
                    image_url: {
                        url: ref,
                        detail: 'high'
                    }
                });
            }
        });
    }

    // Add text prompt
    content.push({
        type: 'text',
        text: prompt
    });

    // Build request body
    const requestBody = {
        model: state.selectedModel,
        messages: [
            {
                role: 'user',
                content: content.length === 1 ? prompt : content
            }
        ],
        modalities: modelConfig.modalities
    };

    // Add Gemini-specific options
    if (modelConfig.supportsImageSize && state.selectedModel.includes('gemini')) {
        requestBody.image_config = {
            image_size: state.imageQuality.toLowerCase(),
            aspect_ratio: state.aspectRatio
        };
    }

    // Add aspect ratio for other models
    if (modelConfig.supportsAspectRatio && !state.selectedModel.includes('gemini')) {
        requestBody.aspect_ratio = state.aspectRatio;
    }

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${state.apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': window.location.origin,
            'X-Title': 'Imagen Internal Tool'
        },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error?.message || `API error: ${response.status}`);
    }

    const data = await response.json();

    // Extract image from response
    // OpenRouter returns images in different formats depending on the model
    const message = data.choices?.[0]?.message;

    if (!message) {
        throw new Error('No response from model');
    }

    // Log full response for debugging
    console.log('API Response:', JSON.stringify(data, null, 2));

    // Check for images array in message (OpenRouter SDK format)
    // According to OpenRouter docs: message.images[].image_url.url
    if (message.images && message.images.length > 0) {
        const img = message.images[0];
        // OpenRouter SDK format: { image_url: { url: "data:image/..." } }
        if (img.image_url?.url) {
            return img.image_url.url;
        }
        // Alternative formats
        if (typeof img === 'string') {
            if (img.startsWith('data:') || img.startsWith('http')) {
                return img;
            }
            return `data:image/png;base64,${img}`;
        }
        if (img.url) return img.url;
        if (img.b64_json) return `data:image/png;base64,${img.b64_json}`;
    }

    // Check for image in content parts (different models may use this format)
    if (Array.isArray(message.content)) {
        for (const part of message.content) {
            // OpenAI-style image_url part
            if (part.type === 'image_url' && part.image_url?.url) {
                return part.image_url.url;
            }
            // Gemini-style inlineData part
            if (part.inlineData?.data) {
                const mimeType = part.inlineData.mimeType || 'image/png';
                return `data:${mimeType};base64,${part.inlineData.data}`;
            }
            // Generic image part
            if (part.type === 'image' && part.image) {
                if (part.image.startsWith('data:')) {
                    return part.image;
                }
                return `data:image/png;base64,${part.image}`;
            }
        }
    }

    // Check if content itself is the image data (some models return this way)
    if (typeof message.content === 'string' && message.content.startsWith('data:image')) {
        return message.content;
    }

    throw new Error('No image in response. Check console for full API response.');
}

// ===== Gallery =====
function renderGallery() {
    if (state.images.length === 0) {
        elements.galleryEmpty.style.display = 'flex';
        elements.gallery.innerHTML = '';
        elements.gallery.appendChild(elements.galleryEmpty);
        return;
    }

    elements.gallery.innerHTML = '';

    state.images.forEach((image, index) => {
        const card = document.createElement('div');
        card.className = 'image-card';

        // Sanitize URL - only allow data URIs and https URLs
        const safeUrl = sanitizeImageUrl(image.url);
        const safePrompt = escapeHtml(image.prompt);

        card.innerHTML = `
            <button class="image-card-delete" data-index="${index}" title="Delete image">🗑️</button>
            <img src="${safeUrl}" alt="${safePrompt}" loading="lazy">
            <div class="image-card-overlay">
                <p class="image-card-prompt">${safePrompt}</p>
                <div class="image-card-meta">
                    <span class="meta-tag">${escapeHtml(image.modelName || image.model)}</span>
                    <span class="meta-tag">${escapeHtml(image.quality || image.size)}</span>
                    <span class="meta-tag">${escapeHtml(image.aspectRatio)}</span>
                </div>
            </div>
        `;

        // Delete button handler
        const deleteBtn = card.querySelector('.image-card-delete');
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteImage(index);
        });

        // Open modal on card click
        card.addEventListener('click', () => openModal(image));
        elements.gallery.appendChild(card);
    });
}

async function deleteImage(index) {
    const imageToDelete = state.images[index];
    state.images.splice(index, 1);

    try {
        await ImagenDB.deleteImage(imageToDelete.id);
    } catch (e) {
        console.warn('Could not delete from IndexedDB:', e);
    }

    renderGallery();
    showToast('Image deleted', 'success');
}

// ===== Modal =====
function openModal(image) {
    state.currentImage = image;
    elements.modalImage.src = sanitizeImageUrl(image.url);
    elements.modalMetadata.innerHTML = `
        <p><strong>Prompt:</strong> ${escapeHtml(image.prompt)}</p>
        <p><strong>Model:</strong> ${escapeHtml(image.modelName || image.model)}</p>
        <p><strong>Size/Quality:</strong> ${escapeHtml(image.quality || image.size)}</p>
        <p><strong>Aspect Ratio:</strong> ${escapeHtml(image.aspectRatio)}</p>
        <p><strong>Created:</strong> ${escapeHtml(new Date(image.createdAt).toLocaleString())}</p>
        ${image.references?.length > 0 ? `<p><strong>References Used:</strong> ${escapeHtml(image.references.length)}</p>` : ''}
    `;
    elements.imageModal.classList.add('active');
}

function closeModal() {
    elements.imageModal.classList.remove('active');
    state.currentImage = null;
}

function useImageAsReference() {
    if (!state.currentImage) return;

    state.references.push(state.currentImage.url);
    renderReferenceSlots();
    closeModal();
    showToast('Image added as reference', 'success');
}

function recreateImage() {
    if (!state.currentImage) return;

    // Restore prompt
    elements.promptInput.value = state.currentImage.prompt;
    elements.charCount.textContent = `${state.currentImage.prompt.length} chars`;

    // Restore model using custom select
    state.selectedModel = state.currentImage.model;
    localStorage.setItem('imagen_model', state.selectedModel);
    const modelOption = document.querySelector(`.custom-select-option[data-value="${state.currentImage.model}"]`);
    if (modelOption) {
        document.querySelectorAll('.custom-select-option').forEach(o => o.classList.remove('selected'));
        modelOption.classList.add('selected');
        elements.modelSelectValue.textContent = modelOption.textContent;
    }
    updateGeminiOptionsVisibility();

    // Restore quality/size
    document.querySelectorAll('.btn-toggle').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.quality === state.currentImage.quality) {
            btn.classList.add('active');
            state.imageSize = btn.dataset.size;
            state.imageQuality = btn.dataset.quality;
        }
    });

    // Restore aspect ratio
    document.querySelectorAll('.btn-aspect').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.ratio === state.currentImage.aspectRatio) {
            btn.classList.add('active');
            state.aspectRatio = state.currentImage.aspectRatio;
        }
    });

    // Restore references
    if (state.currentImage.references && state.currentImage.references.length > 0) {
        state.references = [...state.currentImage.references];
        renderReferenceSlots();
    }

    closeModal();
    showToast('Settings restored. Click Generate to recreate.', 'success');

    // Scroll to top
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function downloadCurrentImage() {
    if (!state.currentImage) return;

    const link = document.createElement('a');
    link.href = state.currentImage.url;
    link.download = `imagen_${state.currentImage.id}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast('Download started', 'success');
}

// ===== UI Helpers =====
function updateGeminiOptionsVisibility() {
    const isGemini = state.selectedModel.includes('gemini');
    elements.geminiOptions.style.display = isGemini ? 'flex' : 'none';
}

function showToast(message, type = 'info') {
    let container = document.querySelector('.toast-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'toast-container';
        document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'slideIn 0.3s ease reverse';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function escapeHtml(text) {
    if (text == null) return '';
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}

function sanitizeImageUrl(url) {
    if (!url) return '';
    // Only allow data URIs and HTTPS URLs
    if (url.startsWith('data:image/')) {
        return url;
    }
    if (url.startsWith('https://')) {
        // Escape any potential attribute-breaking characters
        return url.replace(/"/g, '%22').replace(/'/g, '%27');
    }
    // Block everything else (http, javascript:, etc.)
    console.warn('Blocked unsafe image URL:', url);
    return '';
}

// ===== Global functions for inline handlers =====
window.removeReference = removeReference;

// ===== Initialize =====
document.addEventListener('DOMContentLoaded', init);
