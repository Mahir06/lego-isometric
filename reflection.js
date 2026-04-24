import html2canvas from 'html2canvas';

export class ReflectionManager {
    constructor(game) {
        this.game = game;
        this.modal = document.getElementById('reflection-modal');
        this.input = document.getElementById('reflection-input');
        this.promptDisplay = document.getElementById('reflection-prompt-display');
        this.dateDisplay = document.getElementById('reflection-date');
        this.signatureName = document.getElementById('reflection-signature-name');
        this.grid = document.getElementById('reflections-grid');
        this.galleryScreen = document.getElementById('landing-reflections-gallery');
        
        // Photo elements
        this.photoBtn = document.getElementById('add-photo-btn');
        this.photoContainer = document.getElementById('reflection-photo-container');
        this.photoDisplay = document.getElementById('reflection-photo-display');
        this.captureOverlay = document.getElementById('capture-overlay');
        this.performCaptureBtn = document.getElementById('perform-capture-btn');
        
        // Mirror element for export
        this.mirror = document.getElementById('reflection-text-mirror');
        
        this.currentPhotoData = null;
        
        this.setupEventListeners();
    }

    setupEventListeners() {
        document.getElementById('save-reflection-btn').onclick = () => this.saveAndExport();
        document.getElementById('close-reflection-btn').onclick = () => this.hideModal();
        document.getElementById('view-reflections-btn').onclick = () => this.showGallery();
        document.getElementById('back-to-landing-btn').onclick = () => this.hideGallery();
        
        if (this.photoBtn) this.photoBtn.onclick = () => this.startCaptureFlow();
        if (this.performCaptureBtn) this.performCaptureBtn.onclick = () => this.executeCapture();
    }

    showModal(promptText = "Write a few sentences about what you learned in this activity.", onClose = null) {
        this.promptDisplay.innerText = promptText;
        this.onCloseCallback = onClose;
        this.dateDisplay.innerText = new Date().toLocaleDateString('en-US', { 
            month: 'long', day: 'numeric', year: 'numeric' 
        });
        this.signatureName.innerText = this.game.playerName || "Builder";
        this.input.value = "";
        this.currentPhotoData = null;
        if (this.photoContainer) this.photoContainer.classList.add('hidden');
        if (this.photoDisplay) this.photoDisplay.src = "";
        
        this.modal.classList.remove('hidden');
    }

    startCaptureFlow() {
        this.modal.classList.add('hidden');
        this.captureOverlay.classList.remove('hidden');
        
        // Ensure UI container is visible to see the build
        document.getElementById('ui-container').classList.remove('hidden');
    }

    executeCapture() {
        // Hide overlay for capture
        this.captureOverlay.classList.add('hidden');
        
        // Temporarily hide game UI elements that shouldn't be in the photo
        const grid = this.game.grid;
        const ghost = this.game.ghostBrick;
        const wasGridVisible = grid ? grid.visible : false;
        const wasGhostVisible = ghost ? ghost.visible : false;
        
        if (grid) grid.visible = false;
        if (ghost) ghost.visible = false;
        
        // Force a render
        this.game.renderer.render(this.game.scene, this.game.camera);
        
        // Capture data URL
        const dataUrl = this.game.renderer.domElement.toDataURL('image/png');
        this.currentPhotoData = dataUrl;
        
        // Restore visibility
        if (grid) grid.visible = wasGridVisible;
        if (ghost) ghost.visible = wasGhostVisible;
        
        // Update reflection modal UI
        this.photoDisplay.src = dataUrl;
        this.photoContainer.classList.remove('hidden');
        
        // Return to reflection modal
        this.modal.classList.remove('hidden');
    }

    hideModal() {
        this.modal.classList.add('hidden');
        if (this.onCloseCallback) {
            this.onCloseCallback();
            this.onCloseCallback = null;
        }
    }

    async saveAndExport() {
        const text = this.input.value.trim();
        if (!text) {
            alert("Please write something before saving!");
            return;
        }

        const reflection = {
            id: Date.now(),
            date: new Date().toISOString(),
            prompt: this.promptDisplay.innerText,
            text: text,
            playerName: this.game.playerName || "Builder",
            photo: this.currentPhotoData
        };

        // Save to localStorage
        const reflections = JSON.parse(localStorage.getItem('pp_reflections') || '[]');
        reflections.unshift(reflection);
        localStorage.setItem('pp_reflections', JSON.stringify(reflections));

        // Export PNG
        const letter = document.getElementById('reflection-letter');
        
        // Use mirror div for export to handle multiline text properly in html2canvas
        if (this.mirror) {
            this.mirror.innerText = this.input.value;
            this.mirror.classList.remove('hidden');
            this.input.classList.add('hidden');
        }
        
        try {
            const canvas = await html2canvas(letter, {
                backgroundColor: '#fdfcf0',
                scale: 2, 
                logging: false,
                useCORS: true
            });
            
            const link = document.createElement('a');
            link.download = `reflection-${reflection.id}.png`;
            link.href = canvas.toDataURL('image/png');
            link.click();
            
            alert("Reflection saved and downloaded!");
        } catch (error) {
            console.error("Export failed:", error);
            alert("Failed to export PNG. But your reflection has been saved in the gallery!");
        } finally {
            // Restore UI
            if (this.mirror) {
                this.mirror.classList.add('hidden');
                this.input.classList.remove('hidden');
            }
            this.hideModal();
        }
    }

    showGallery() {
        this.renderGallery();
        this.game.showScreen('reflections-gallery'); // We need to add this to showScreen map or handle it here
        // If we can't modify main.js showScreen easily, we do it manually:
        const screens = document.querySelectorAll('.landing-content');
        screens.forEach(s => s.classList.add('hidden'));
        this.galleryScreen.classList.remove('hidden');
        document.getElementById('global-back-btn').classList.remove('hidden');
    }

    hideGallery() {
        this.galleryScreen.classList.add('hidden');
        // Return to home
        document.getElementById('landing-step-1').classList.remove('hidden');
        document.getElementById('global-back-btn').classList.add('hidden');
    }

    renderGallery() {
        const reflections = JSON.parse(localStorage.getItem('pp_reflections') || '[]');
        this.grid.innerHTML = "";

        if (reflections.length === 0) {
            this.grid.innerHTML = `
                <div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: #888;">
                    <div style="font-size: 40px; margin-bottom: 15px;">📜</div>
                    <p>You haven't written any reflections yet.</p>
                    <p style="font-size: 0.8rem;">Complete a game mode to write your first one!</p>
                </div>
            `;
            return;
        }

        reflections.forEach(ref => {
            const dateStr = new Date(ref.date).toLocaleDateString('en-US', { 
                month: 'short', day: 'numeric', year: 'numeric' 
            });
            const card = document.createElement('div');
            card.className = 'reflection-card';
            card.innerHTML = `
                <div class="reflection-card-date">${dateStr}</div>
                <div class="reflection-card-prompt">${ref.prompt}</div>
                <div class="reflection-card-text">${ref.text}</div>
                ${ref.photo ? `<div class="reflection-card-photo-indicator">📷 Photo Attached</div>` : ''}
            `;
            card.onclick = () => this.previewReflection(ref);
            this.grid.appendChild(card);
        });
    }

    previewReflection(refData) {
        // Show the modal with existing data (read-only-ish)
        this.promptDisplay.innerText = refData.prompt;
        this.dateDisplay.innerText = new Date(refData.date).toLocaleDateString('en-US', { 
            month: 'long', day: 'numeric', year: 'numeric' 
        });
        this.signatureName.innerText = refData.playerName;
        this.input.value = refData.text;
        
        if (refData.photo) {
            this.photoDisplay.src = refData.photo;
            this.photoContainer.classList.remove('hidden');
            this.currentPhotoData = refData.photo;
        } else {
            this.photoContainer.classList.add('hidden');
            this.currentPhotoData = null;
        }
        
        // Temporarily change button to just "Re-export"
        const saveBtn = document.getElementById('save-reflection-btn');
        const oldText = saveBtn.innerText;
        saveBtn.innerText = "Re-export PNG";
        
        const closeBtn = document.getElementById('close-reflection-btn');
        const oldCloseText = closeBtn.innerText;
        closeBtn.innerText = "Close";

        this.modal.classList.remove('hidden');

        // Cleanup when closing
        const originalClose = closeBtn.onclick;
        closeBtn.onclick = () => {
            saveBtn.innerText = oldText;
            closeBtn.innerText = oldCloseText;
            closeBtn.onclick = originalClose;
            this.hideModal();
        };
    }
}
