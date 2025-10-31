/*
 * Waze Korrelations-Logger - v16 "Live Diagnose-Dashboard"
 * ========================================================
 *
 * BASIS: v15 (Stabiler "Anti-Schlaf-Hack" + "IP-Sniffer")
 *
 * NEU in v16 (Deine Idee):
 * 1. Lädt extern Chart.js (siehe index.html).
 * 2. Initialisiert zwei Live-Charts beim START:
 * a) gpsChart: Zeigt GPS-Genauigkeit (Acc) und G-Kraft (Jolt).
 * b) orientationChart: Zeigt die Handy-Ausrichtung (Beta/Gamma).
 * 3. Die Sensor-Handler (logPosition, logDeviceMotion) füttern
 * jetzt *auch* diese Live-Charts.
 * 4. STOP-Button zerstört die Charts, um Speicher freizugeben.
 *
 * Gebaut von deinem Sparingpartner.
 */
"use strict";

document.addEventListener("DOMContentLoaded", () => {
    
    // --- DOM-Elemente ---
    const statusEl = document.getElementById('status');
    const logAreaEl = document.getElementById('logArea');
    const permissionBtn = document.getElementById('permissionBtn');
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const crashBtn = document.getElementById('crashBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const fallbackToggle = document.getElementById('fallbackToggle');
    const liveDashboard = document.getElementById('liveDashboard');
    const networkStatusEl = document.getElementById('networkStatus');
    
    // --- v16: Chart-Kontexte ---
    const gpsChartCtx = document.getElementById('gpsChart')?.getContext('2d');
    const orientationChartCtx = document.getElementById('orientationChart')?.getContext('2d');
    let gpsChart = null;
    let orientationChart = null;
    const CHART_MAX_DATA_POINTS = 50; // Nur die letzten 50 Punkte anzeigen

    // --- Logger-Status ---
    let isLogging = false;
    let logEntries = [];
    let geoWatchId = null;
    let permissionsState = { gps: false, motion: false, orientation: false, network: false, webrtc: false };
    let v16_chartErrorLogged = false; // Verhindert Log-Spam

    // --- v14: Anti-Schlaf-Audio-Kontext ---
    let antiSleepContext = null;
    let antiSleepOscillator = null;

    // --- v15: Netzwerk-Zwei-Zangen-Attacke ---
    let networkCheckInterval = null;
    let lastNetworkType = "unknown";
    let lastOnlineStatus = navigator.onLine;
    const NETWORK_POLL_INTERVAL_MS = 3000;
    
    let ipSnifferInterval = null;
    let lastLocalIP = "";
    const IP_SNIFFER_INTERVAL_MS = 10000;
    let rtcPeerConnection = null; 

    // --- v6: DEBUG Heartbeat Flags ---
    let motionSensorHasFired = false;
    let orientationSensorHasFired = false;

    // --- v5: Flugschreiber & Jolt Detection ---
    let flightRecorderBuffer = [];
    const FLIGHT_RECORDER_DURATION_MS = 2500;
    const JOLT_THRESHOLD_MS2 = 25.0; 
    const JOLT_COOLDOWN_MS = 5000; 
    let lastJoltTime = 0;

    // --- Hilfsfunktion: Delay ---
    function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

    // --- Universal-Funktion zum Loggen (ins Haupt-Log) ---
    function getTimestamp() { return new Date().toISOString(); }
    const logDebug = (window.logDebug || console.log);

    function addLogEntry(message, level = 'info') {
        const logString = `${getTimestamp()} | ${message}`;
        logEntries.push(logString);
        if (level === 'error') console.error(logString);
        else if (level === 'warn') console.warn(logString);
        else console.log(logString);
        updateLogDisplay();
    }

    function updateLogDisplay() {
         if (logAreaEl) {
            logAreaEl.value = logEntries.slice(-100).join('\n');
            logAreaEl.scrollTop = logAreaEl.scrollHeight;
         }
    }

    // --- v5: Flugschreiber-Funktionen ---
    function pushToFlightRecorder(timestamp, type, dataString) {
        flightRecorderBuffer.push({ timestamp, type, dataString });
        const cutoffTime = timestamp - FLIGHT_RECORDER_DURATION_MS;
        while (flightRecorderBuffer.length > 0 && flightRecorderBuffer[0].timestamp < cutoffTime) {
            flightRecorderBuffer.shift();
        }
    }
    function dumpFlightRecorder(markerTime, reason) {
        addLogEntry(`\n--- !!! ${reason} (${markerTime}) !!! ---`, 'warn');
        addLogEntry(`--- START FLUGSCHREIBER-DUMP (Letzte ${FLIGHT_RECORDER_DURATION_MS}ms) ---`, 'warn');
        if (flightRecorderBuffer.length === 0) { addLogEntry(" (Flugschreiber-Puffer ist leer) ", 'warn'); }
        else {
            [...flightRecorderBuffer].forEach(entry => {
                const timeDiff = new Date(markerTime).getTime() - entry.timestamp;
                const timeAgo = (timeDiff / 1000).toFixed(3);
                addLogEntry(`[T-${timeAgo}s] | ${entry.type} | ${entry.dataString}`, 'info');
            });
        }
        addLogEntry("--- ENDE FLUGSCHREIBER-DUMP ---\n", 'warn');
    }

    // ===================================
    // --- v16: CHART-FUNKTIONEN ---
    // ===================================

    // Globale Chart-Stil-Optionen
    Chart.defaults.color = '#e0e0e0';
    Chart.defaults.borderColor = '#444';

    function initCharts() {
        if (typeof Chart === 'undefined') {
            if (!v16_chartErrorLogged) {
                addLogEntry("FEHLER: Chart.js (Chart) ist nicht definiert. Stelle sicher, dass die Bibliothek geladen wird.", 'error');
                v16_chartErrorLogged = true;
            }
            return; 
        }
        
        // --- GPS- & G-Kraft-Chart ---
        if (gpsChartCtx) {
            gpsChart = new Chart(gpsChartCtx, {
                type: 'line',
                data: { labels: [], datasets: [
                    { label: 'GPS Genauigkeit (m)', data: [], borderColor: '#03a9f4', backgroundColor: 'rgba(3, 169, 244, 0.3)', fill: false, tension: 0.1, yAxisID: 'yGps' },
                    { label: 'G-Kraft (m/s²)', data: [], borderColor: '#f44336', backgroundColor: 'rgba(244, 67, 54, 0.3)', fill: false, tension: 0.1, yAxisID: 'yGforce' }
                ]},
                options: {
                    scales: {
                        x: { display: false },
                        yGps: { type: 'linear', position: 'left', title: { display: true, text: 'GPS (m)' }, ticks: { color: '#03a9f4' } },
                        yGforce: { type: 'linear', position: 'right', title: { display: true, text: 'G-Kraft' }, ticks: { color: '#f44336' }, grid: { drawOnChartArea: false } }
                    },
                    animation: { duration: 200 },
                    maintainAspectRatio: false
                }
            });
        }
        
        // --- Orientierungs-Chart ---
        if (orientationChartCtx) {
            orientationChart = new Chart(orientationChartCtx, {
                type: 'bar',
                data: { labels: ['Neigung (X)', 'Seitenneigung (Y)'], datasets: [
                    { label: 'Grad', data: [0, 0], backgroundColor: ['#bb86fc', '#03dac6'], borderWidth: 1 }
                ]},
                options: {
                    indexAxis: 'y',
                    scales: { x: { min: -180, max: 180 }, y: { display: false } },
                    animation: { duration: 0 },
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } }
                }
            });
        }
    }

    // Zerstört Charts beim Stoppen
    function destroyCharts() {
        if (gpsChart) { gpsChart.destroy(); gpsChart = null; }
        if (orientationChart) { orientationChart.destroy(); orientationChart = null; }
    }

    // Fügt Daten zu einem Chart hinzu und hält ihn auf 50 Punkte
    function addDataToChart(chart, label, dataArray) {
        if (!chart) return;
        
        chart.data.labels.push(label);
        dataArray.forEach((value, index) => {
            chart.data.datasets[index].data.push(value);
        });

        if (chart.data.labels.length > CHART_MAX_DATA_POINTS) {
            chart.data.labels.shift();
            chart.data.datasets.forEach(dataset => {
                dataset.data.shift();
            });
        }
        chart.update();
    }
    
    // Aktualisiert die Balken des Orientierungs-Charts
    function updateBarChart(chart, dataArray) {
        if (!chart) return;
        chart.data.datasets[0].data = dataArray;
        chart.update();
    }


    // ===================================
    // --- SENSOR-HANDLER (v16) ---
    // ===================================

    // 1. GPS-Erfolg (v16: füttert jetzt Chart)
    function logPosition(position) { 
        const coords = position.coords;
        const speedKmh = (coords.speed ? coords.speed * 3.6 : 0).toFixed(1);
        const accuracy = coords.accuracy.toFixed(1);
        
        // Loggen
        const logData = [ `GPS-OK | Acc: ${accuracy}m`, `Speed: ${speedKmh} km/h` ];
        addLogEntry(logData.join(' | '));
        statusEl.textContent = `LOGGING... (GPS: ${accuracy}m)`;
        
        // v16: Chart füttern (nur GPS-Teil)
        const timeLabel = getTimestamp().slice(11, 19);
        addDataToChart(gpsChart, timeLabel, [accuracy, null]); // null für G-Kraft
     }

    // 2. GPS-Fehler
    function logError(error) { 
        let message = '';
        switch(error.code) {
            case error.PERMISSION_DENIED: message = "GPS-Zugriff verweigert"; break;
            case error.POSITION_UNAVAILABLE: message = "Position nicht verfügbar (Kein Signal)"; break;
            case error.TIMEOUT: message = "GPS-Timeout"; break;
            default: message = `Unbekannter GPS-Fehler (Code: ${error.code})`;
        }
        addLogEntry(`GPS-FEHLER: ${message}`, 'error');
        statusEl.textContent = "Fehler: GPS-Problem!";
     }
    
    // 3. v14: Netzwerk-Wächter (Polling-Funktion - Zange 1)
    function checkNetworkState(isInitialCall = false) {
        // (Identisch zu v15)
        if (!permissionsState.network) return; 
        try {
            const isOnline = navigator.onLine;
            let currentType = 'unknown';
            if (!isOnline) { currentType = 'offline'; }
            else { const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
                currentType = connection ? connection.type : 'cellular'; }
            
            if (currentType === 'offline') {
                liveDashboard.className = 'dashboard-offline'; networkStatusEl.textContent = 'STATUS: OFFLINE';
            } else if (currentType === 'wifi') {
                liveDashboard.className = 'dashboard-wifi'; networkStatusEl.textContent = 'NETZ: WIFI (VERBUNDEN?)';
            } else if (currentType === 'cellular') {
                liveDashboard.className = 'dashboard-cellular'; networkStatusEl.textContent = 'NETZ: MOBILFUNK';
            } else {
                liveDashboard.className = 'dashboard-unknown'; networkStatusEl.textContent = `NETZ: ${currentType.toUpperCase()}`;
            }

            if (currentType !== lastNetworkType || isOnline !== lastOnlineStatus || isInitialCall) {
                const logString = `NETZWERK-STATUS: Online: ${isOnline} | Typ: ${currentType}`;
                if (isInitialCall) { addLogEntry(logString, 'info'); }
                else { addLogEntry('NETZWERK-EVENT: Verbindungs-Status geändert!', 'warn'); addLogEntry(logString, 'warn'); }
                lastNetworkType = currentType; lastOnlineStatus = isOnline;
            }
        } catch (err) {
            addLogEntry(`NETZWERK-FEHLER: ${err.message}`, 'error');
            permissionsState.network = false; 
            if (networkCheckInterval) clearInterval(networkCheckInterval);
        }
    }

    // 4. v15: IP-Sniffer (Polling-Funktion - Zange 2)
    function checkLocalIP() {
        // (Identisch zu v15)
        if (!permissionsState.webrtc) return;
        try {
            if (rtcPeerConnection) { rtcPeerConnection.close(); rtcPeerConnection = null; }
            const PeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection;
            const rtc = new PeerConnection({ iceServers: [] });
            rtcPeerConnection = rtc;
            rtc.createDataChannel(''); 
            rtc.onicecandidate = (event) => {
                if (event.candidate && event.candidate.candidate) {
                    const ipRegex = /(192\.168\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[0-1])\.[0-9]{1,3}\.[0-9]{1,3}|10\.[0-9]{1,3}\.[0-9]{1,3})/g;
                    const match = ipRegex.exec(event.candidate.candidate);
                    if (match) {
                        const newLocalIP = match[0];
                        if (newLocalIP !== lastLocalIP) {
                            addLogEntry(`IP-SNIFFER: Lokale IP-Änderung! Neue IP: ${newLocalIP}`, 'warn');
                            lastLocalIP = newLocalIP;
                        }
                        if (rtc) { rtc.close(); rtcPeerConnection = null; }
                    }
                }
            };
            rtc.createOffer()
                .then(offer => rtc.setLocalDescription(offer))
                .catch(err => addLogEntry(`IP-SNIFFER: Fehler beim Erstellen des Offers: ${err.message}`, 'error'));
        } catch (err) {
            addLogEntry(`IP-SNIFFER: Kritischer Fehler: ${err.message}`, 'error');
            permissionsState.webrtc = false; 
            if (ipSnifferInterval) clearInterval(ipSnifferInterval);
        }
    }

    // 5. Bewegungssensor (v16: füttert jetzt Chart)
    function logDeviceMotion(event) {
        const now = Date.now();
        const acc = event.accelerationIncludingGravity;
        if (!motionSensorHasFired) {
            motionSensorHasFired = true;
            if (!acc || acc.x === null) { addLogEntry("DEBUG: 'devicemotion' feuert, ABER DATEN SIND NULL.", 'warn'); }
            else { addLogEntry("DEBUG: 'devicemotion' feuert erfolgreich mit Daten.", 'info'); }
        }
        if (!acc || acc.x === null) return; 
        
        // Flugschreiber füttern
        const dataString = `X: ${acc.x.toFixed(2)} | Y: ${acc.y.toFixed(2)} | Z: ${acc.z.toFixed(2)}`;
        pushToFlightRecorder(now, 'MOTION', dataString);
        
        // G-Kraft berechnen
        const gForce = Math.sqrt(acc.x**2 + acc.y**2 + acc.z**2);
        
        // v16: Chart füttern (nur G-Kraft-Teil)
        const timeLabel = getTimestamp().slice(11, 19);
        addDataToChart(gpsChart, timeLabel, [null, gForce]); // null für GPS
        
        // Jolt-Detection
        if (gForce > JOLT_THRESHOLD_MS2 && (now - lastJoltTime > JOLT_COOLDOWN_MS)) {
            lastJoltTime = now;
            const reason = `HARTER STOSS ERKANNT (G-Force: ${gForce.toFixed(1)})`;
            dumpFlightRecorder(getTimestamp(), reason);
        }
    }

    // 6. Orientierungssensor (v16: füttert jetzt Chart)
    function logDeviceOrientation(event) {
        const now = Date.now();
        if (!orientationSensorHasFired) {
            orientationSensorHasFired = true;
            if (event.alpha === null) { addLogEntry("DEBUG: 'deviceorientation' feuert, ABER DATEN SIND NULL.", 'warn'); }
            else { addLogEntry("DEBUG: 'deviceorientation' feuert erfolgreich mit Daten.", 'info'); }
        }
        if (event.alpha === null) return;
        
        // Flugschreiber füttern
        const dataString = `Alpha(Z): ${event.alpha.toFixed(1)} | Beta(X): ${event.beta.toFixed(1)} | Gamma(Y): ${event.gamma.toFixed(1)}`;
        pushToFlightRecorder(now, 'ORIENTATION', dataString);
        
        // v16: Chart füttern
        updateBarChart(orientationChart, [event.beta.toFixed(1), event.gamma.toFixed(1)]);
    }
    
    // 7. v14: Anti-Schlaf-Hack (Stilles Audio)
    function startAntiSleepAudio() {
        // (Identisch zu v15)
        try {
            if (antiSleepContext) { antiSleepContext.close(); } 
            antiSleepContext = new (window.AudioContext || window.webkitAudioContext)();
            antiSleepOscillator = antiSleepContext.createOscillator();
            antiSleepOscillator.type = 'sine'; antiSleepOscillator.frequency.setValueAtTime(1, antiSleepContext.currentTime); 
            const gainNode = antiSleepContext.createGain();
            gainNode.gain.setValueAtTime(0.0, antiSleepContext.currentTime); 
            antiSleepOscillator.connect(gainNode); gainNode.connect(antiSleepContext.destination);
            antiSleepOscillator.start();
            addLogEntry("DEBUG: 'Anti-Schlaf-Hack' (Stilles Audio) gestartet.", 'info');
        } catch (e) { addLogEntry(`FEHLER: 'Anti-Schlaf-Hack' konnte nicht gestartet werden: ${e.message}`, 'error'); }
    }
    function stopAntiSleepAudio() {
         // (Identisch zu v15)
         try {
            if (antiSleepOscillator) { antiSleepOscillator.stop(); antiSleepOscillator = null; }
            if (antiSleepContext) { antiSleepContext.close(); antiSleepContext = null; }
            addLogEntry("DEBUG: 'Anti-Schlaf-Hack' (Stilles Audio) gestoppt.", 'info');
         } catch (e) { addLogEntry(`FEHLER: 'Anti-Schlaf-Hack' konnte nicht gestoppt werden: ${e.message}`, 'error'); }
    }

    // ===================================
    // --- STEUERUNGS-FUNKTIONEN (v16) ---
    // ===================================

    // Phase A: Pre-Flight Check (Identisch zu v15)
    async function requestAllPermissions() {
        // (Identisch zu v15)
        addLogEntry("Phase A: Fordere Berechtigungen an (v16)...");
        statusEl.textContent = "Berechtigungen anfordern...";
        const useFallback = fallbackToggle.checked;
        if (useFallback) { addLogEntry("DEBUG v16: 'Alte API erzwingen' ist AKTIV. Überspringe 'requestPermission'.", 'warn'); }
        
        addLogEntry("DEBUG v16: Fordere GPS an...");
        try {
            if (!navigator.geolocation) throw new Error("Geolocation wird nicht unterstützt.");
            await new Promise((resolve, reject) => { navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 10000 }); });
            permissionsState.gps = true; addLogEntry("DEBUG v16: BERECHTIGUNG: GPS erteilt.");
        } catch (err) { addLogEntry(`BERECHTIGUNG: GPS-Fehler (${err.message})`, 'error'); permissionsState.gps = false; }
        addLogEntry("DEBUG v16: GPS-Anfrage abgeschlossen.");

        addLogEntry("DEBUG v16: Prüfe Netzwerk-API...");
        if ('connection' in navigator || 'mozConnection' in navigator || 'webkitConnection' in navigator) {
            permissionsState.network = true; addLogEntry("DEBUG v16: BERECHTIGUNG: Netzwerk-API gefunden.");
        } else { addLogEntry("BERECHTIGUNG: Netzwerk-API wird nicht unterstützt!", 'warn'); }

        addLogEntry("DEBUG v16: Prüfe WebRTC-API (IP-Sniffer)...");
        if ('RTCPeerConnection' in window || 'webkitRTCPeerConnection' in window) {
            permissionsState.webrtc = true; addLogEntry("DEBUG v16: BERECHTIGUNG: WebRTC-API gefunden.");
        } else { addLogEntry("BERECHTIGUNG: WebRTC-API wird nicht unterstützt!", 'warn'); }
        addLogEntry("DEBUG v16: Netzwerk-Checks abgeschlossen.");
        
        addLogEntry("DEBUG v16: Prüfe Bewegungssensor...");
        if (useFallback) {
            permissionsState.motion = true; addLogEntry("DEBUG v16: BERECHTIGUNG: Bewegungssensor (Fallback erzwungen) OK.");
        } else if (typeof(DeviceMotionEvent.requestPermission) === 'function') {
            addLogEntry("DEBUG v16: 'requestPermission' Motion-API erkannt, fordere an...");
            try {
                const state = await DeviceMotionEvent.requestPermission();
                permissionsState.motion = (state === 'granted');
                addLogEntry(`DEBUG v16: BERECHTIGUNG: Bewegungssensor-Status: '${state}'`, (state === 'granted' ? 'info' : 'warn'));
            } catch (err) { addLogEntry(`DEBUG v16: BERECHTIGUNG: Bewegungssensor-Fehler: ${err.message}`, 'error'); permissionsState.motion = false; }
        } else if ('DeviceMotionEvent' in window) {
             permissionsState.motion = true; addLogEntry("DEBUG v16: BERECHTIGUNG: Bewegungssensor (Implizit/Alt) OK.");
        } else { addLogEntry("BERECHTIGUNG: Bewegungssensor wird nicht unterstützt!", 'error'); permissionsState.motion = false; }
        addLogEntry("DEBUG v16: Bewegungssensor-Check abgeschlossen.");

        addLogEntry("DEBUG v16: Füge kleine Pause ein (500ms)..."); await delay(500); 
        addLogEntry("DEBUG v16: Prüfe Orientierungssensor...");
        if (useFallback) {
             permissionsState.orientation = true; addLogEntry("DEBUG v16: BERECHTIGUNG: Orientierungssensor (Fallback erzwungen) OK.");
        } else if (typeof(DeviceOrientationEvent.requestPermission) === 'function') {
             addLogEntry("DEBUG v16: 'requestPermission' Orientation-API erkannt, fordere an...");
            try {
                const state = await DeviceOrientationEvent.requestPermission();
                permissionsState.orientation = (state === 'granted');
                addLogEntry(`DEBUG v16: BERECHTIGUNG: Orientierungssensor-Status: '${state}'`, (state === 'granted' ? 'info' : 'warn'));
            } catch (err) { addLogEntry(`DEBUG v16: BERECHTIGUNG: Orientierungssensor-Fehler: ${err.message}`, 'error'); permissionsState.orientation = false; }
        } else if ('DeviceOrientationEvent' in window) {
            permissionsState.orientation = true; addLogEntry("DEBUG v1f: BERECHTIGUNG: Orientierungssensor (Implizit/Alt) OK.");
        } else { addLogEntry("BERECHTIGUNG: Orientierungssensor wird nicht unterstützt!", 'error'); permissionsState.orientation = false; }
        addLogEntry("DEBUG v16: Orientierungssensor-Check abgeschlossen.");
        
        addLogEntry("Phase A: Pre-Flight Check beendet.");
        return permissionsState.gps; 
    }

    // Phase B: Startet alle Logger (v16)
    async function startAllLoggers() {
        addLogEntry("Phase B: Starte alle Logger (v16)...");
        statusEl.textContent = "LOGGING... (Starte Sensoren)";

        // 1. Display sperren
        addLogEntry("DEBUG: Versuche, Display-Rotation zu sperren ('portrait')...");
        try {
            if (screen.orientation && typeof screen.orientation.lock === 'function') {
                await screen.orientation.lock('portrait-primary');
                addLogEntry("DEBUG: Display-Rotation erfolgreich auf 'portrait' gesperrt.", 'info');
            } else { addLogEntry("DEBUG: 'screen.orientation.lock' API nicht gefunden.", 'warn'); }
        } catch (err) { addLogEntry(`DEBUG: Display-Rotation konnte nicht gesperrt werden: ${err.message}`, 'warn'); }

        // 2. Anti-Schlaf-Audio STARTEN
        startAntiSleepAudio();
        
        // 3. v16: Charts initialisieren
        initCharts();
        
        // 4. GPS-Logger
        const geoOptions = { enableHighAccuracy: true, timeout: 10000, maximumAge: 1000 };
        geoWatchId = navigator.geolocation.watchPosition(logPosition, logError, geoOptions);
        addLogEntry("DEBUG: 'geolocation.watchPosition' Listener angehängt.");
        
        // 5. Netzwerk-Wächter (Zange 1)
        if (permissionsState.network) {
            networkCheckInterval = setInterval(checkNetworkState, NETWORK_POLL_INTERVAL_MS);
            addLogEntry(`DEBUG: Netzwerk-Wächter (Typ) Polling gestartet (Intervall: ${NETWORK_POLL_INTERVAL_MS}ms).`);
            checkNetworkState(true); 
        }
        
        // 6. IP-Sniffer (Zange 2)
        if (permissionsState.webrtc) {
            ipSnifferInterval = setInterval(checkLocalIP, IP_SNIFFER_INTERVAL_MS);
            addLogEntry(`DEBUG: IP-Sniffer (WebRTC) Polling gestartet (Intervall: ${IP_SNIFFER_INTERVAL_MS}ms).`);
            checkLocalIP(); 
        }

        // 7. Bewegungs-Sensor-Logger
        if (permissionsState.motion) {
            window.addEventListener('devicemotion', logDeviceMotion);
            addLogEntry("DEBUG: 'devicemotion' Listener angehängt.");
        } else { addLogEntry("WARNUNG: Bewegungssensor-Listener NICHT angehängt.", 'warn'); }
        
        // 8. Orientierungs-Sensor-Logger
        if (permissionsState.orientation) {
            window.addEventListener('deviceorientation', logDeviceOrientation);
            addLogEntry("DEBUG: 'deviceorientation' Listener angehängt.");
        } else { addLogEntry("WARNUNG: Orientierungssensor-Listener NICHT angehängt.", 'warn'); }
        
        isLogging = true;
        startBtn.disabled = true; permissionBtn.disabled = true;
        stopBtn.disabled = false; crashBtn.disabled = false;
        downloadBtn.disabled = true; fallbackToggle.disabled = true;
    }

    // ===================================
    // --- BUTTON-HANDLER (v16) ---
    // ===================================

    // PRE-FLIGHT CHECK
    permissionBtn.onclick = async () => {
        permissionBtn.disabled = true; startBtn.disabled = true; 
        statusEl.textContent = "Prüfe Berechtigungen...";
        logEntries = []; flightRecorderBuffer = []; logAreaEl.value = "";
        lastNetworkType = "unknown"; lastOnlineStatus = navigator.onLine; lastLocalIP = "";
        permissionsState = { gps: false, motion: false, orientation: false, network: false, webrtc: false };
        v16_chartErrorLogged = false;
        
        const gpsOk = await requestAllPermissions();

        if (gpsOk) {
            statusEl.textContent = "Bereit zum Loggen! (GPS OK)";
            startBtn.disabled = false; downloadBtn.disabled = true; permissionBtn.disabled = true; 
            fallbackToggle.disabled = true; 
        } else {
            statusEl.textContent = "Fehler: GPS-Berechtigung benötigt!";
            permissionBtn.disabled = false; 
        }
    };

    // START
    startBtn.onclick = () => {
        logEntries = []; flightRecorderBuffer = []; logAreaEl.value = "Starte Logging...\n";
        motionSensorHasFired = false; orientationSensorHasFired = false; 
        lastNetworkType = "unknown"; lastOnlineStatus = navigator.onLine; lastLocalIP = "";
        
        addLogEntry(`Logging-Prozess angefordert (v16)...`);
        startAllLoggers();
    };

    // STOP
    stopBtn.onclick = () => {
        if (!isLogging) return;
        
        // Alle Timer und Listener stoppen
        stopAntiSleepAudio();
        if (geoWatchId) navigator.geolocation.clearWatch(geoWatchId);
        if (networkCheckInterval) clearInterval(networkCheckInterval); 
        if (ipSnifferInterval) clearInterval(ipSnifferInterval);
        if (rtcPeerConnection) { rtcPeerConnection.close(); rtcPeerConnection = null; }

        window.removeEventListener('devicemotion', logDeviceMotion);
        window.removeEventListener('deviceorientation', logDeviceOrientation);
        
        // v16: Charts zerstören
        destroyCharts();
        
        // Display-Rotation wieder freigeben
        try {
             if (screen.orientation && typeof screen.orientation.unlock === 'function') {
                screen.orientation.unlock();
                addLogEntry("DEBUG: Display-Rotation wieder freigegeben.", 'info');
             }
        } catch (err) { addLogEntry(`DEBUG: Fehler beim Freigeben der Display-Rotation: ${err.message}`, 'warn'); }
        
        isLogging = false;
        geoWatchId = null; networkCheckInterval = null; ipSnifferInterval = null;
        flightRecorderBuffer = [];
        addLogEntry("Logging gestoppt.");

        // UI zurücksetzen
        statusEl.textContent = "Status: Gestoppt. Download bereit.";
        startBtn.disabled = true; 
        permissionBtn.disabled = false; 
        stopBtn.disabled = true;
        crashBtn.disabled = true;
        downloadBtn.disabled = false; 
        fallbackToggle.disabled = false; 
        liveDashboard.className = 'dashboard-unknown';
        networkStatusEl.textContent = 'BEREIT';
    };

    // ABSTURZ MARKIEREN
    crashBtn.onclick = () => { 
        if (!isLogging) return;
        const markerTime = getTimestamp();
        dumpFlightRecorder(markerTime, "ABSTURZ VOM NUTZER MARKIERT");
        statusEl.textContent = "ABSTURZ MARKIERT & DUMP ERSTELLT!";
        setTimeout(() => { if(isLogging) statusEl.textContent = "LOGGING..."; }, 3000);
    };

    // DOWNLOAD
    downloadBtn.onclick = () => { 
        if (logEntries.length === 0) { alert("Keine Logs zum Herunterladen vorhanden."); return; }
        const logData = logEntries.join('\n');
        const blob = new Blob([logData], { type: 'text/plain;charset=utf-8' }); 
        const filename = `waze_log_v16_${new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-')}.txt`;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(a.href); 
    };

    // Initialen Button-Status und Dashboard setzen
    startBtn.disabled = true;
    stopBtn.disabled = true;
    crashBtn.disabled = true;
    downloadBtn.disabled = true;
    liveDashboard.className = 'dashboard-unknown';
    networkStatusEl.textContent = 'BEREIT';
});
