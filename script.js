document.addEventListener('DOMContentLoaded', () => {
    // Initialize audio context
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    
    // Master volume control
    const masterGain = audioContext.createGain();
    masterGain.gain.value = 0.8;
    masterGain.connect(audioContext.destination);
    
    document.getElementById('masterVolume').addEventListener('input', (e) => {
        masterGain.gain.value = parseFloat(e.target.value);
    });

    // Automix Queue - holds files loaded by user for automixing
    const automixQueue = [];
    let automixQueueIndex = 0; // Current index for automix to pick next track

    // Playlist UI elements
    const playlistTracksUl = document.getElementById('playlistTracks');
    const playlistCountSpan = document.getElementById('playlistCount');
    const clearPlaylistBtn = document.getElementById('clearPlaylistBtn');
    
    // Deck class to manage each deck's state and functionality
    class Deck {
        constructor(deckNumber) {
            this.deckNumber = deckNumber;
            this.fileInput = document.getElementById(`fileInput${deckNumber}`);
            this.playPauseBtn = document.querySelector(`.play-pause-btn[data-deck="${deckNumber}"]`);
            this.volumeSlider = document.querySelector(`.volume-slider[data-deck="${deckNumber}"]`);
            this.bpmDisplay = document.getElementById(`bpm${deckNumber}`);
            this.pitchSlider = document.querySelector(`.pitch-slider[data-deck="${deckNumber}"]`);
            this.pitchValue = document.getElementById(`pitchValue${deckNumber}`);
            this.trackInfo = document.getElementById(`trackInfo${deckNumber}`);
            this.syncBtn = document.querySelector(`.sync-btn[data-deck="${deckNumber}"]`);
            this.cueBtn = document.querySelector(`.cue-btn[data-deck="${deckNumber}"]`);
            this.loopInBtn = document.querySelector(`.loop-in-btn[data-deck="${deckNumber}"]`);
            this.loopOutBtn = document.querySelector(`.loop-out-btn[data-deck="${deckNumber}"]`);
            this.loopBtn = document.querySelector(`.loop-btn[data-deck="${deckNumber}"]`);
            this.loopLengthSelect = document.querySelector(`.loop-length-select[data-deck="${deckNumber}"]`);
            this.jogWheel = document.getElementById(`jog${deckNumber}`);

            // Hot Cue elements
            this.hotCueButtons = document.querySelectorAll(`.hotcue-btn[data-deck="${deckNumber}"]`);
            this.clearHotCuesBtn = document.querySelector(`.hotcue-clear-btn[data-deck="${deckNumber}"]`);

            // FX elements
            this.lpfFilterSlider = document.querySelector(`.lpf-filter[data-deck="${deckNumber}"]`);
            
            // Initialize properties
            this.bpm = null;
            this.isPlaying = false;
            this.isSynced = false;
            this.isLooping = false;
            this.loopStart = null;
            this.loopEnd = null;
            this.cuePoint = 0;
            this.pitch = 0;
            this.audioBuffer = null; // Store audio buffer for BPM analysis
            this.wavesurfer = null;
            this.hotCues = {}; // Stores { '1': time, '2': time, '3': time }
            
            this.eq = {
                high: audioContext.createBiquadFilter(),
                mid: audioContext.createBiquadFilter(),
                low: audioContext.createBiquadFilter()
            };
            this.lpfFilter = audioContext.createBiquadFilter(); // Low Pass Filter for FX
            
            // Setup audio nodes
            this.gainNode = audioContext.createGain();
            this.gainNode.gain.value = parseFloat(this.volumeSlider.value); // Ensure initial gain matches slider
            
            // Setup EQ and connect to master gain
            this.setupAudioChain();
            
            // Setup waveform
            this.setupWaveform();
            
            // Setup event listeners
            this.setupEventListeners();
        }
        
        setupAudioChain() {
            // EQ configuration
            this.eq.high.type = "highshelf";
            this.eq.high.frequency.value = 5000;
            this.eq.mid.type = "peaking";
            this.eq.mid.frequency.value = 1000;
            this.eq.mid.Q.value = 1;
            this.eq.low.type = "lowshelf";
            this.eq.low.frequency.value = 250;

            // LPF configuration (default open)
            this.lpfFilter.type = "lowpass";
            this.lpfFilter.frequency.value = 22000; // Default: fully open
            this.lpfFilter.Q.value = 1; // Quality factor

            // Connect EQ nodes in series: High -> Mid -> Low
            this.eq.high.connect(this.eq.mid);
            this.eq.mid.connect(this.eq.low);
            
            // Connect EQ output to LPF, then LPF to Deck Gain Node, then Deck Gain Node to Master Gain
            this.eq.low.connect(this.lpfFilter); // EQ output feeds into LPF
            this.lpfFilter.connect(this.gainNode); // LPF output feeds into Deck's main gain
            this.gainNode.connect(masterGain); // Deck's main gain feeds into master output
            
            // Set up EQ controls
            document.querySelector(`.eq-high[data-deck="${this.deckNumber}"]`).addEventListener('input', (e) => {
                this.eq.high.gain.value = (parseFloat(e.target.value) - 1) * 12; // Adjust gain from -12dB to +12dB
            });
            
            document.querySelector(`.eq-mid[data-deck="${this.deckNumber}"]`).addEventListener('input', (e) => {
                this.eq.mid.gain.value = (parseFloat(e.target.value) - 1) * 12;
            });
            
            document.querySelector(`.eq-low[data-deck="${this.deckNumber}"]`).addEventListener('input', (e) => {
                this.eq.low.gain.value = (parseFloat(e.target.value) - 1) * 12;
            });

            // Set up LPF control
            this.lpfFilterSlider.addEventListener('input', (e) => {
                this.lpfFilter.frequency.value = parseFloat(e.target.value);
            });
        }
        
        setupWaveform() {
            // Destroy existing wavesurfer instance if it exists to prevent memory leaks/re-initialization issues
            if (this.wavesurfer) {
                this.wavesurfer.destroy();
            }

            this.wavesurfer = WaveSurfer.create({
                container: `#waveform${this.deckNumber}`,
                waveColor: this.deckNumber === '1' ? '#4a6bff' : '#ff4a4a',
                progressColor: 'rgba(0, 255, 0, 0.5)',
                cursorColor: 'transparent',
                barWidth: 2,
                barRadius: 2,
                cursorWidth: 0,
                height: 120,
                barGap: 1,
                responsive: true,
                normalize: true, // Normalizes the waveform peaks to fill the height
                partialRender: true, // Only render visible portion
                backend: 'WebAudio',
                mediaControls: false,
                audioContext: audioContext,
                audioRate: 1 + (this.pitch / 100), // Initial playback rate based on pitch
                autoCenter: true,
            });

            // Reconnect Wavesurfer's internal audio output to the EQ input after it loads a file
            this.wavesurfer.on('load', (url) => {
                if (this.wavesurfer.webAudio && this.wavesurfer.webAudio.gainNode) {
                    this.wavesurfer.webAudio.gainNode.disconnect();
                    this.wavesurfer.webAudio.gainNode.connect(this.eq.high); // Connect Wavesurfer output to EQ high-band input
                } else {
                    console.warn(`Deck ${this.deckNumber}: Wavesurfer gainNode not found after load. Check Wavesurfer implementation.`);
                }
            });
            
            this.wavesurfer.on('ready', () => {
                this.analyzeBPM();
                // Update play/pause button state only if track is ready
                this.playPauseBtn.innerHTML = '<i class="fas fa-play"></i>';
                this.playPauseBtn.classList.remove('active');
                this.isPlaying = false; // Reset play state
                this.wavesurfer.clearRegions(); // Clear any old loop/cue regions
                this.updateHotCueMarkers(); // Redraw hot cue markers
            });
            
            this.wavesurfer.on('audioprocess', () => {
                const position = document.getElementById(`position${this.deckNumber}`);
                if (position && this.wavesurfer && this.wavesurfer.getDuration() > 0) {
                    const progress = this.wavesurfer.getCurrentTime() / this.wavesurfer.getDuration();
                    position.style.left = `${progress * 100}%`;
                }
            });
            
            this.wavesurfer.on('finish', () => {
                this.playPauseBtn.innerHTML = '<i class="fas fa-play"></i>';
                this.isPlaying = false;
                this.playPauseBtn.classList.remove('active');
            });

            // Handle user clicks on the waveform to set cue point
            this.wavesurfer.on('interaction', (newTime) => {
                this.cuePoint = newTime;
                console.log(`Deck ${this.deckNumber}: Cue point set to ${newTime.toFixed(2)}s`);
            });
        }
        
        setupEventListeners() {
            // File input (now supports multiple files)
            this.fileInput.addEventListener('change', async (e) => {
                const files = e.target.files;
                if (files.length > 0) {
                    // If loading multiple, load the first one to the deck, and add all to playlist
                    this.loadFile(files[0]);
                    for (let i = 0; i < files.length; i++) {
                        if (!automixQueue.some(qFile => qFile.name === files[i].name && qFile.size === files[i].size)) {
                            automixQueue.push(files[i]);
                            console.log(`Added "${files[i].name}" to automix queue. Total: ${automixQueue.length} tracks.`);
                        }
                    }
                    renderPlaylist(); // Update playlist display
                }
            });
            
            // Play/Pause button
            this.playPauseBtn.addEventListener('click', () => {
                if (audioContext.state === 'suspended') {
                    audioContext.resume(); // Resume audio context if it's suspended (e.g., on first user interaction)
                }
                
                if (this.wavesurfer && this.wavesurfer.getDuration() > 0) {
                    this.wavesurfer.playPause();
                    this.isPlaying = this.wavesurfer.isPlaying(); // Get actual state from wavesurfer
                    this.playPauseBtn.innerHTML = this.isPlaying ? '<i class="fas fa-pause"></i>' : '<i class="fas fa-play"></i>';
                    this.playPauseBtn.classList.toggle('active', this.isPlaying);
                } else {
                    console.warn(`Deck ${this.deckNumber}: No track loaded to play.`);
                }
            });
            
            // Volume control
            this.volumeSlider.addEventListener('input', () => {
                // When individual volume changes, re-calculate crossfader effect
                const crossfaderValue = parseFloat(document.getElementById('crossfader').value);
                mixer.updateCrossfader(crossfaderValue); // Call mixer's update function
            });
            
            // Pitch control
            this.pitchSlider.addEventListener('input', (e) => {
                this.pitch = parseFloat(e.target.value);
                this.pitchValue.textContent = `${this.pitch > 0 ? '+' : ''}${this.pitch.toFixed(1)}%`;
                
                if (this.wavesurfer) {
                    // Wavesurfer v7+ handles pitch changes directly through audioRate
                    this.wavesurfer.setPlaybackRate(1 + (this.pitch / 100));
                }
            });
            
            // Sync button
            this.syncBtn.addEventListener('click', () => {
                this.isSynced = !this.isSynced;
                this.syncBtn.classList.toggle('active', this.isSynced);
                
                if (this.isSynced && this.bpm && mixer.decks.some(deck => deck.bpm && deck.deckNumber !== this.deckNumber)) {
                    // Find the other deck with a valid BPM
                    const otherDeck = mixer.decks.find(deck => deck.bpm && deck.deckNumber !== this.deckNumber);
                    if (otherDeck && otherDeck.bpm) {
                        const targetBPM = otherDeck.bpm;
                        // Calculate pitch change needed to match BPM
                        this.pitch = ((targetBPM / this.bpm) - 1) * 100;
                        this.pitchSlider.value = this.pitch;
                        this.pitchValue.textContent = `${this.pitch > 0 ? '+' : ''}${this.pitch.toFixed(1)}%`;
                        
                        if (this.wavesurfer) {
                            this.wavesurfer.setPlaybackRate(1 + (this.pitch / 100));
                        }
                        console.log(`Deck ${this.deckNumber} synced to Deck ${otherDeck.deckNumber}. New Pitch: ${this.pitch.toFixed(1)}%`);
                    } else {
                        console.warn(`Deck ${this.deckNumber}: Cannot sync: Other deck's BPM is not available.`);
                        this.isSynced = false; // Turn off sync if no valid target
                        this.syncBtn.classList.remove('active');
                    }
                } else if (!this.isSynced) {
                    console.log(`Deck ${this.deckNumber}: Sync disabled.`);
                    // Optionally reset pitch to 0 when sync is turned off
                    // this.pitch = 0;
                    // this.pitchSlider.value = 0;
                    // this.pitchValue.textContent = '±0.0%';
                    // if (this.wavesurfer) this.wavesurfer.setPlaybackRate(1);
                } else {
                    console.warn(`Deck ${this.deckNumber}: Cannot sync: BPM not available for this deck.`);
                    this.isSynced = false;
                    this.syncBtn.classList.remove('active');
                }
            });
            
            // Cue button
            this.cueBtn.addEventListener('click', () => {
                if (this.wavesurfer && this.wavesurfer.getDuration() > 0) {
                    this.wavesurfer.seekTo(this.cuePoint / this.wavesurfer.getDuration()); // Seek to percentage
                    if (!this.isPlaying) {
                        this.wavesurfer.play();
                        this.isPlaying = true;
                        this.playPauseBtn.innerHTML = '<i class="fas fa-pause"></i>';
                        this.playPauseBtn.classList.add('active');
                        setTimeout(() => {
                            this.wavesurfer.pause();
                            this.isPlaying = false;
                            this.playPauseBtn.innerHTML = '<i class="fas fa-play"></i>';
                            this.playPauseBtn.classList.remove('active');
                        }, 500); // Play for 0.5 seconds then pause
                        console.log(`Deck ${this.deckNumber}: Cue triggered to ${this.cuePoint.toFixed(2)}s.`);
                    } else {
                        console.log(`Deck ${this.deckNumber}: Already playing, seeking to cue point ${this.cuePoint.toFixed(2)}s.`);
                        this.wavesurfer.seekTo(this.cuePoint / this.wavesurfer.getDuration());
                    }
                } else {
                    console.warn(`Deck ${this.deckNumber}: No track loaded for Cue.`);
                }
            });
            
            // Loop controls
            this.loopInBtn.addEventListener('click', () => {
                if (this.wavesurfer && this.wavesurfer.getDuration() > 0) {
                    this.loopStart = this.wavesurfer.getCurrentTime();
                    console.log(`Deck ${this.deckNumber}: Loop IN set at ${this.loopStart.toFixed(2)}s.`);
                    this.updateLoop(); // Update visual region if loop is active
                } else {
                    console.warn(`Deck ${this.deckNumber}: No track loaded to set Loop IN.`);
                }
            });
            
            this.loopOutBtn.addEventListener('click', () => {
                if (this.wavesurfer && this.wavesurfer.getDuration() > 0) {
                    this.loopEnd = this.wavesurfer.getCurrentTime();
                    console.log(`Deck ${this.deckNumber}: Loop OUT set at ${this.loopEnd.toFixed(2)}s.`);
                    this.updateLoop(); // Update visual region if loop is active
                } else {
                    console.warn(`Deck ${this.deckNumber}: No track loaded to set Loop OUT.`);
                }
            });
            
            this.loopBtn.addEventListener('click', () => {
                if (this.wavesurfer && this.loopStart !== null && this.loopEnd !== null && this.loopStart < this.loopEnd) {
                    this.isLooping = !this.isLooping;
                    this.loopBtn.classList.toggle('active', this.isLooping);
                    
                    if (this.isLooping) {
                        this.wavesurfer.setLoop(true); // Enable internal Wavesurfer looping
                        // Add or update the region. Regions automatically loop if setLoop(true)
                        this.wavesurfer.addRegion({ id: 'loop-region', start: this.loopStart, end: this.loopEnd, loop: true, color: 'rgba(255, 0, 0, 0.3)' });
                        console.log(`Deck ${this.deckNumber}: Loop activated from ${this.loopStart.toFixed(2)}s to ${this.loopEnd.toFixed(2)}s.`);
                        if (!this.isPlaying) { // If not playing, jump to start of loop and play
                            this.wavesurfer.seekTo(this.loopStart / this.wavesurfer.getDuration());
                            this.wavesurfer.play();
                            this.isPlaying = true;
                            this.playPauseBtn.innerHTML = '<i class="fas fa-pause"></i>';
                            this.playPauseBtn.classList.add('active');
                        }
                    } else {
                        this.wavesurfer.setLoop(false); // Disable internal Wavesurfer looping
                        this.wavesurfer.clearRegions(); // Remove visual region
                        this.updateHotCueMarkers(); // Redraw hot cue markers, as clearRegions removes them too
                        console.log(`Deck ${this.deckNumber}: Loop deactivated.`);
                    }
                } else {
                    console.warn(`Deck ${this.deckNumber}: Loop points not set correctly (IN: ${this.loopStart}, OUT: ${this.loopEnd}). Set IN and OUT points first, with IN < OUT, and ensure track is loaded.`);
                    this.isLooping = false; // Ensure state is false
                    this.loopBtn.classList.remove('active');
                }
            });

            this.loopLengthSelect.addEventListener('change', (e) => {
                if (this.wavesurfer && this.bpm && this.wavesurfer.getDuration() > 0) {
                    const beats = parseFloat(e.target.value);
                    const beatDuration = 60 / this.bpm; // duration of one beat in seconds
                    const loopDuration = beats * beatDuration;
                    
                    this.loopStart = this.wavesurfer.getCurrentTime();
                    this.loopEnd = this.loopStart + loopDuration;
                    
                    if (this.loopEnd <= this.wavesurfer.getDuration()) {
                        console.log(`Deck ${this.deckNumber}: Loop length set to ${beats} beats (${loopDuration.toFixed(2)}s) from ${this.loopStart.toFixed(2)}s.`);
                        this.updateLoop();
                        if (this.isLooping) { // If already looping, update the loop immediately
                            this.wavesurfer.clearRegions();
                            this.wavesurfer.addRegion({ id: 'loop-region', start: this.loopStart, end: this.loopEnd, loop: true, color: 'rgba(255, 0, 0, 0.3)' });
                        }
                    } else {
                        console.warn(`Deck ${this.deckNumber}: Loop length (${loopDuration.toFixed(2)}s) exceeds track duration from current position. Adjust loop or track.`);
                        this.loopStart = null;
                        this.loopEnd = null;
                        this.wavesurfer.clearRegions(); // Clear if points are invalid
                        this.updateHotCueMarkers(); // Redraw hot cue markers
                    }
                } else {
                    console.warn(`Deck ${this.deckNumber}: Cannot set loop length: track not loaded or BPM not detected.`);
                }
            });
            
            // Jog wheel
            let isDragging = false;
            let lastX = 0;
            
            this.jogWheel.addEventListener('mousedown', (e) => {
                isDragging = true;
                lastX = e.clientX;
                e.preventDefault(); // Prevent default drag behavior
                if (audioContext.state === 'suspended') {
                    audioContext.resume();
                }
            });
            
            document.addEventListener('mousemove', (e) => {
                if (isDragging && this.wavesurfer && this.wavesurfer.getDuration() > 0) {
                    const deltaX = e.clientX - lastX;
                    lastX = e.clientX;
                    
                    // Adjust playback position based on drag
                    const currentTime = this.wavesurfer.getCurrentTime();
                    const newTime = currentTime + (deltaX * 0.05); // Increased sensitivity for better feel
                    this.wavesurfer.seekTo(Math.max(0, Math.min(newTime, this.wavesurfer.getDuration())) / this.wavesurfer.getDuration());
                }
            });
            
            document.addEventListener('mouseup', () => {
                isDragging = false;
            });

            // Hot Cue Buttons
            this.hotCueButtons.forEach(btn => {
                btn.addEventListener('click', () => {
                    const cueNum = btn.dataset.cue;
                    if (!this.wavesurfer || this.wavesurfer.getDuration() === 0) {
                        console.warn(`Deck ${this.deckNumber}: No track loaded to set/jump hot cue.`);
                        return;
                    }

                    if (this.hotCues[cueNum] !== undefined) {
                        // Hot cue already set, jump to it
                        this.wavesurfer.seekTo(this.hotCues[cueNum] / this.wavesurfer.getDuration());
                        console.log(`Deck ${this.deckNumber}: Jumped to Hot Cue ${cueNum} at ${this.hotCues[cueNum].toFixed(2)}s.`);
                        // If not playing, play for a short burst
                        if (!this.isPlaying) {
                            this.wavesurfer.play();
                            this.isPlaying = true;
                            this.playPauseBtn.innerHTML = '<i class="fas fa-pause"></i>';
                            this.playPauseBtn.classList.add('active');
                            setTimeout(() => {
                                this.wavesurfer.pause();
                                this.isPlaying = false;
                                this.playPauseBtn.innerHTML = '<i class="fas fa-play"></i>';
                                this.playPauseBtn.classList.remove('active');
                            }, 500);
                        }
                    } else {
                        // Set hot cue at current position
                        const currentTime = this.wavesurfer.getCurrentTime();
                        this.hotCues[cueNum] = currentTime;
                        btn.classList.add('active'); // Visually activate the button
                        this.addHotCueMarker(cueNum, currentTime); // Add marker to waveform
                        console.log(`Deck ${this.deckNumber}: Hot Cue ${cueNum} set at ${currentTime.toFixed(2)}s.`);
                    }
                });
            });

            this.clearHotCuesBtn.addEventListener('click', () => {
                if (confirm(`Are you sure you want to clear all hot cues for Deck ${this.deckNumber}?`)) {
                    this.hotCues = {}; // Clear all hot cues
                    this.hotCueButtons.forEach(btn => btn.classList.remove('active')); // Deactivate buttons
                    this.wavesurfer.clearRegions(); // Remove all waveform regions (including hot cues)
                    this.updateLoop(); // Redraw loop if it was active
                    console.log(`Deck ${this.deckNumber}: All hot cues cleared.`);
                }
            });
        }
        
        async loadFile(file) {
            this.trackInfo.textContent = file.name;
            
            if (this.wavesurfer) {
                // Ensure audio context is running before loading
                if (audioContext.state === 'suspended') {
                    await audioContext.resume();
                }

                // Destroy and re-create Wavesurfer to ensure a clean state and correct audio graph connections
                this.setupWaveform(); 

                const objectUrl = URL.createObjectURL(file);
                this.wavesurfer.load(objectUrl);
                
                // Clear previous loop points and state
                this.loopStart = null;
                this.loopEnd = null;
                this.isLooping = false;
                this.loopBtn.classList.remove('active');
                this.playPauseBtn.classList.remove('active'); // Reset play/pause button state

                // Clear hot cues on new track load
                this.hotCues = {};
                this.hotCueButtons.forEach(btn => btn.classList.remove('active'));

                // Reset FX filter to default
                this.lpfFilterSlider.value = 22000;
                this.lpfFilter.frequency.value = 22000;

                // Decode audio data to get AudioBuffer for BPM analysis
                const reader = new FileReader();
                reader.onload = async (e) => {
                    try {
                        const buffer = await audioContext.decodeAudioData(e.target.result);
                        this.audioBuffer = buffer;
                        this.analyzeBPM(); // Re-analyze BPM for the new track
                        console.log(`Deck ${this.deckNumber}: Loaded "${file.name}"`);
                    } catch (err) {
                        console.error(`Deck ${this.deckNumber}: Error decoding audio data`, err);
                        this.trackInfo.textContent = `Error loading: ${file.name}`;
                        this.bpmDisplay.textContent = '--';
                    }
                };
                reader.readAsArrayBuffer(file);
            }
        }
        
        analyzeBPM() {
            // This is a simplified BPM detection - in a real app you'd use a more accurate library
            if (this.wavesurfer && this.wavesurfer.getDuration()) {
                const duration = this.wavesurfer.getDuration();
                // A very crude way to derive a "BPM" from duration to make it vary a bit
                // This is NOT a real BPM algorithm, but gives a dynamic number.
                const estimatedBPM = Math.round(120 + (duration % 20) * 0.5); // Example formula, highly inaccurate
                this.bpm = Math.max(80, Math.min(estimatedBPM, 180)); // Keep it in a reasonable range
                this.bpmDisplay.textContent = this.bpm;
            } else {
                this.bpm = null;
                this.bpmDisplay.textContent = '--';
            }
        }
        
        updateLoop() {
            if (this.wavesurfer && this.loopStart !== null && this.loopEnd !== null && this.loopStart < this.loopEnd) {
                // First, clear all regions, then add back hot cues, then add loop region
                this.wavesurfer.clearRegions();
                this.updateHotCueMarkers(); // Redraw hot cues after clearing
                this.wavesurfer.addRegion({
                    id: 'loop-region', // Give it an ID to differentiate
                    start: this.loopStart,
                    end: this.loopEnd,
                    loop: this.isLooping, // Loop if the loop button is active
                    color: 'rgba(255, 0, 0, 0.3)',
                });
            } else {
                 this.wavesurfer.clearRegions(); // Clear if points are invalid or not set
                 this.updateHotCueMarkers(); // Redraw hot cues after clearing
            }
        }

        addHotCueMarker(cueNum, time) {
            if (this.wavesurfer) {
                this.wavesurfer.addRegion({
                    id: `hotcue-${cueNum}`,
                    start: time,
                    end: time + 0.1, // A very short region to act as a marker
                    color: 'rgba(255, 165, 0, 0.5)', // Orange color for hot cues
                    drag: false,
                    resize: false,
                    loop: false
                });
            }
        }

        updateHotCueMarkers() {
            // Re-add existing hot cue markers after clearRegions might have removed them
            for (const cueNum in this.hotCues) {
                if (this.hotCues.hasOwnProperty(cueNum)) {
                    this.addHotCueMarker(cueNum, this.hotCues[cueNum]);
                    // Also ensure buttons are active if hot cue exists
                    document.querySelector(`.hotcue-btn[data-deck="${this.deckNumber}"][data-cue="${cueNum}"]`).classList.add('active');
                }
            }
        }
    }
    
    // Mixer class to manage both decks and crossfader
    class Mixer {
        constructor() {
            this.decks = [
                new Deck('1'),
                new Deck('2')
            ];
            
            this.setupCrossfader();
        }
        
        setupCrossfader() {
            const crossfader = document.getElementById('crossfader');
            
            crossfader.addEventListener('input', (e) => {
                const value = parseFloat(e.target.value);
                this.updateCrossfader(value);
            });

            // Initial crossfader update to set correct volumes based on its initial position
            this.updateCrossfader(parseFloat(crossfader.value));
        }

        updateCrossfader(value) {
            // Equal power crossfade curve
            const gain1 = Math.cos(value * 0.5 * Math.PI);
            const gain2 = Math.cos((1 - value) * 0.5 * Math.PI);
            
            // Apply crossfader gain on top of individual deck volumes from their sliders
            this.decks[0].gainNode.gain.value = gain1 * parseFloat(this.decks[0].volumeSlider.value);
            this.decks[1].gainNode.gain.value = gain2 * parseFloat(this.decks[1].volumeSlider.value);
        }
    }
    
    // Initialize the mixer
    const mixer = new Mixer();

    // Automix functionality
    let automixInterval = null;
    let currentActiveDeckIndex = 0; // 0 for Deck 1, 1 for Deck 2

    document.getElementById('automixBtn').addEventListener('click', () => {
        if (automixInterval) {
            clearInterval(automixInterval);
            automixInterval = null;
            document.getElementById('automixBtn').classList.remove('active');
            console.log('Automix stopped.');
        } else {
            // Check if there are enough tracks for automix to start meaningfully
            if (automixQueue.length < 2 && (!mixer.decks[0].audioBuffer || !mixer.decks[1].audioBuffer)) {
                 console.warn("Automix requires at least two tracks loaded in the queue or on the decks.");
                 alert("Моля, заредете поне две песни (чрез бутоните 'Load Track' или влачене), за да използвате Automix.");
                 return;
            }
            document.getElementById('automixBtn').classList.add('active');
            console.log('Automix started.');
            startAutomix();
        }
    });

    async function startAutomix() {
        const crossfadeDuration = 5; // seconds for the crossfade
        const checkInterval = 2000; // milliseconds to check remaining time

        // Ensure audio context is running
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }

        // Initial check and play if no track is playing but one is available
        const initialActiveDeck = mixer.decks[currentActiveDeckIndex];
        if (!initialActiveDeck.isPlaying && initialActiveDeck.wavesurfer && initialActiveDeck.wavesurfer.getDuration() > 0) {
            initialActiveDeck.wavesurfer.play();
            initialActiveDeck.isPlaying = true;
            initialActiveDeck.playPauseBtn.innerHTML = '<i class="fas fa-pause"></i>';
            initialActiveDeck.playPauseBtn.classList.add('active');
            // Set crossfader to the initially active deck
            const initialCrossfaderValue = currentActiveDeckIndex === 0 ? 0 : 1;
            document.getElementById('crossfader').value = initialCrossfaderValue;
            mixer.updateCrossfader(initialCrossfaderValue);
        } else if (!initialActiveDeck.audioBuffer && automixQueue.length > 0) {
            // If the initial active deck is empty, try to load from queue
            await loadNextTrackForAutomix(currentActiveDeckIndex);
            if (initialActiveDeck.audioBuffer) { // If successfully loaded, play it
                initialActiveDeck.wavesurfer.play();
                initialActiveDeck.isPlaying = true;
                initialActiveDeck.playPauseBtn.innerHTML = '<i class="fas fa-pause"></i>';
                initialActiveDeck.playPauseBtn.classList.add('active');
                const initialCrossfaderValue = currentActiveDeckIndex === 0 ? 0 : 1;
                document.getElementById('crossfader').value = initialCrossfaderValue;
                mixer.updateCrossfader(initialCrossfaderValue);
            }
        }


        automixInterval = setInterval(async () => {
            const activeDeck = mixer.decks[currentActiveDeckIndex];
            const inactiveDeck = mixer.decks[1 - currentActiveDeckIndex];
            
            // Handle case where active deck is empty or finishes unexpectedly
            if (!activeDeck.wavesurfer || activeDeck.wavesurfer.getDuration() === 0 || (!activeDeck.isPlaying && activeDeck.wavesurfer.getDuration() > 0 && activeDeck.wavesurfer.getCurrentTime() >= activeDeck.wavesurfer.getDuration() - 0.1)) {
                console.warn(`Deck ${activeDeck.deckNumber} is empty, finished, or not playing. Attempting to load and play next track.`);
                activeDeck.wavesurfer.stop(); // Ensure it's stopped
                activeDeck.isPlaying = false;
                activeDeck.playPauseBtn.innerHTML = '<i class="fas fa-play"></i>';
                activeDeck.playPauseBtn.classList.remove('active');

                if (await loadNextTrackForAutomix(currentActiveDeckIndex)) { // Load into the active deck
                    activeDeck.wavesurfer.play();
                    activeDeck.isPlaying = true;
                    activeDeck.playPauseBtn.innerHTML = '<i class="fas fa-pause"></i>';
                    activeDeck.playPauseBtn.classList.add('active');
                    // Immediately set crossfader to this deck if it was previously empty
                    const crossfaderValue = currentActiveDeckIndex === 0 ? 0 : 1;
                    document.getElementById('crossfader').value = crossfaderValue;
                    mixer.updateCrossfader(crossfaderValue);
                } else {
                    console.error("No more tracks in automix queue or unable to load. Stopping automix.");
                    clearInterval(automixInterval);
                    automixInterval = null;
                    document.getElementById('automixBtn').classList.remove('active');
                    return;
                }
            }
            
            // Recalculate remaining time after potential load/play
            const remainingTime = activeDeck.wavesurfer.getDuration() - activeDeck.wavesurfer.getCurrentTime();
            
            // Trigger crossfade when active track is near end AND inactive deck has a track ready or can load one
            // We use `remainingTime > 0.5` to avoid initiating crossfade when track is literally at the very end
            if (remainingTime <= crossfadeDuration + 2 && remainingTime > 0.5) { 
                // Ensure inactive deck has a track, or try to load the next one
                if (!inactiveDeck.audioBuffer || inactiveDeck.wavesurfer.getDuration() === 0) {
                    console.log(`Deck ${inactiveDeck.deckNumber} needs a track. Loading next from queue...`);
                    const loaded = await loadNextTrackForAutomix(1 - currentActiveDeckIndex); // Load into inactive deck
                    if (!loaded) {
                        console.warn(`No more tracks in automix queue for Deck ${inactiveDeck.deckNumber}. Cannot perform crossfade.`);
                        // Keep playing current track until end, then automix will stop or try to load again
                        return;
                    }
                }

                // If inactive deck has loaded a track and is not already playing
                if (inactiveDeck.audioBuffer && inactiveDeck.wavesurfer.getDuration() > 0 && !inactiveDeck.isPlaying) {
                    console.log(`Starting automix crossfade from Deck ${activeDeck.deckNumber} to Deck ${inactiveDeck.deckNumber}`);
                    
                    inactiveDeck.wavesurfer.play();
                    inactiveDeck.isPlaying = true;
                    inactiveDeck.playPauseBtn.innerHTML = '<i class="fas fa-pause"></i>';
                    inactiveDeck.playPauseBtn.classList.add('active');

                    const startTime = audioContext.currentTime;
                    
                    // Clear any previous scheduled values for smooth transition
                    activeDeck.gainNode.gain.cancelScheduledValues(startTime);
                    inactiveDeck.gainNode.gain.cancelScheduledValues(startTime);

                    // Fade out active deck
                    activeDeck.gainNode.gain.linearRampToValueAtTime(0, startTime + crossfadeDuration);
                    
                    // Fade in inactive deck (to its set volume slider value)
                    inactiveDeck.gainNode.gain.linearRampToValueAtTime(parseFloat(inactiveDeck.volumeSlider.value), startTime + crossfadeDuration);

                    // Smoothly move the crossfader UI
                    const crossfaderElement = document.getElementById('crossfader');
                    const targetCrossfaderValue = (1 - currentActiveDeckIndex); // 0 for Deck1, 1 for Deck2
                    const currentCrossfaderValue = parseFloat(crossfaderElement.value);
                    const steps = crossfadeDuration * 10; // 10 steps per second
                    let stepCount = 0;
                    
                    const crossfadeUiInterval = setInterval(() => {
                        stepCount++;
                        if (stepCount <= steps) {
                            const interpolatedValue = currentCrossfaderValue + (targetCrossfaderValue - currentCrossfaderValue) * (stepCount / steps);
                            crossfaderElement.value = interpolatedValue;
                            mixer.updateCrossfader(interpolatedValue); // Update actual audio gains
                        } else {
                            clearInterval(crossfadeUiInterval);
                            crossfaderElement.value = targetCrossfaderValue; // Ensure final state is exact
                            mixer.updateCrossfader(targetCrossfaderValue);
                        }
                    }, 100); // Update UI every 100ms

                    // After crossfade completes, stop the previous deck
                    setTimeout(() => {
                        activeDeck.wavesurfer.pause();
                        activeDeck.isPlaying = false;
                        activeDeck.playPauseBtn.innerHTML = '<i class="fas fa-play"></i>';
                        activeDeck.playPauseBtn.classList.remove('active');
                        
                        // Switch the current deck for the next cycle
                        currentActiveDeckIndex = 1 - currentActiveDeckIndex;
                        console.log(`Switched active deck to Deck ${mixer.decks[currentActiveDeckIndex].deckNumber}`);
                    }, crossfadeDuration * 1000); // Convert to milliseconds
                } else if (inactiveDeck.isPlaying) {
                    console.log(`Deck ${inactiveDeck.deckNumber} is already playing. Waiting for next cycle or track end.`);
                }
            }

        }, checkInterval);
    }

    // Function to load the next track from the automixQueue into a specific deck
    async function loadNextTrackForAutomix(deckIndex) {
        if (automixQueue.length === 0) {
            console.warn("Automix queue is empty. Cannot load next track.");
            return false;
        }

        const deckToLoad = mixer.decks[deckIndex];
        let nextTrackFile = null;

        // Find the next track in the queue that is not currently loaded on the other deck
        // This prevents loading the same track into both decks if only two are available
        const otherDeck = mixer.decks[1 - deckIndex];
        
        for (let i = 0; i < automixQueue.length; i++) {
            const potentialTrackIndex = (automixQueueIndex + i) % automixQueue.length;
            const potentialTrack = automixQueue[potentialTrackIndex];
            
            // Check if the potential track is already loaded on the other deck by comparing filename and size
            if (!otherDeck.audioBuffer || !(potentialTrack.name === otherDeck.trackInfo.textContent && potentialTrack.size === otherDeck.currentFile.size)) {
                nextTrackFile = potentialTrack;
                automixQueueIndex = (potentialTrackIndex + 1) % automixQueue.length; // Advance index
                break;
            }
        }

        if (nextTrackFile) {
            console.log(`Loading "${nextTrackFile.name}" into Deck ${deckToLoad.deckNumber} for automix.`);
            // Update Deck's currentFile property
            deckToLoad.currentFile = nextTrackFile; 
            await deckToLoad.loadFile(nextTrackFile);
            return true;
        } else {
            console.warn("No suitable next track found in automix queue to load (or all tracks are currently on decks).");
            return false;
        }
    }
    
    // Enable file drop functionality globally
    document.addEventListener('dragover', (e) => {
        e.preventDefault(); // Prevent default behavior to allow drop
        e.dataTransfer.dropEffect = 'copy'; // Visual feedback
    });
    
    document.addEventListener('drop', (e) => {
        e.preventDefault();
        // Determine which deck the file was dropped on, or if it's a general drop for the playlist
        const deckElement = e.target.closest('.deck');
        const files = e.dataTransfer.files;

        if (files.length > 0) {
            // Filter for audio files
            const audioFiles = Array.from(files).filter(file => file.type.startsWith('audio/'));

            if (audioFiles.length > 0) {
                // If dropped on a specific deck, load the first audio file to that deck
                if (deckElement) {
                    const deckId = deckElement.id.replace('deck', '');
                    const deck = mixer.decks[parseInt(deckId) - 1]; // Get the correct Deck object (0-indexed array)
                    
                    deck.loadFile(audioFiles[0]);
                    // Add all dropped audio files to the playlist
                    audioFiles.forEach(file => {
                        if (!automixQueue.some(qFile => qFile.name === file.name && qFile.size === file.size)) {
                            automixQueue.push(file);
                        }
                    });
                    renderPlaylist();
                    console.log(`Loaded "${audioFiles[0].name}" to Deck ${deck.deckNumber} and added all ${audioFiles.length} files to automix queue (via drag/drop).`);
                } else {
                    // If dropped anywhere else, just add all audio files to the playlist
                    audioFiles.forEach(file => {
                        if (!automixQueue.some(qFile => qFile.name === file.name && qFile.size === file.size)) {
                            automixQueue.push(file);
                        }
                    });
                    renderPlaylist();
                    console.log(`Added ${audioFiles.length} audio files to automix queue (via drag/drop).`);
                    alert(`Добавени са ${audioFiles.length} песни към плейлиста.`);
                }
            } else {
                console.warn("Dropped files are not audio files.");
            }
        }
    });

    // --- Playlist Functionality ---

    // Function to render the automix queue into the playlist UI
    function renderPlaylist() {
        playlistTracksUl.innerHTML = ''; // Clear current list
        playlistCountSpan.textContent = `(${automixQueue.length} tracks)`;

        if (automixQueue.length === 0) {
            const li = document.createElement('li');
            li.textContent = 'No tracks in playlist. Load some!';
            li.style.textAlign = 'center';
            li.style.color = 'var(--text-dim)';
            li.style.cursor = 'default';
            li.style.padding = '15px';
            li.style.backgroundColor = 'transparent';
            li.style.borderBottom = 'none';
            playlistTracksUl.appendChild(li);
            return;
        }

        automixQueue.forEach((file, index) => {
            const li = document.createElement('li');
            li.dataset.index = index; // Store index for later reference

            const trackNameSpan = document.createElement('span');
            trackNameSpan.classList.add('track-name');
            trackNameSpan.textContent = file.name;
            li.appendChild(trackNameSpan);

            // Add "Load to Deck" buttons
            const loadButtonsDiv = document.createElement('div');
            
            const loadDeck1Btn = document.createElement('button');
            loadDeck1Btn.classList.add('load-to-deck');
            loadDeck1Btn.textContent = 'Load to Deck 1';
            loadDeck1Btn.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent li click event from firing
                mixer.decks[0].loadFile(file);
                console.log(`Loaded "${file.name}" to Deck 1 from playlist.`);
            });
            loadButtonsDiv.appendChild(loadDeck1Btn);

            const loadDeck2Btn = document.createElement('button');
            loadDeck2Btn.classList.add('load-to-deck');
            loadDeck2Btn.textContent = 'Load to Deck 2';
            loadDeck2Btn.addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent li click event from firing
                mixer.decks[1].loadFile(file);
                console.log(`Loaded "${file.name}" to Deck 2 from playlist.`);
            });
            loadButtonsDiv.appendChild(loadDeck2Btn);

            li.appendChild(loadButtonsDiv);

            playlistTracksUl.appendChild(li);
        });
    }

    // Clear Playlist button functionality
    clearPlaylistBtn.addEventListener('click', () => {
        if (confirm('Are you sure you want to clear the entire playlist? This will not unload tracks from decks.')) {
            automixQueue.length = 0; // Empty the array
            automixQueueIndex = 0; // Reset automix index
            renderPlaylist(); // Update UI
            console.log('Playlist cleared.');
            alert('Плейлистът е изчистен!');
        }
    });

    // Initial render of the playlist when the page loads
    renderPlaylist();
});