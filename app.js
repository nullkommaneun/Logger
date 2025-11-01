/*
 * Waze Korrelations-Logger - v20 "Bereinigt"
 * ==========================================
 *
 * BASIS: v19 (Stabiler WakeLock, Stabile Charts)
 *
 * PLAN v20:
 * 1. RAUS: Der "Fallback-Toggle" (v13) wird
 * sowohl aus der UI (HTML/CSS) als auch aus der
 * Logik (JS) entfernt. Er war auf Canary 144
 * nicht mehr nötig.
 * 2. OPTIMIERUNG: Code wird bereinigt, alle
 * "useFallback"-Prüfungen werden entfernt.
 * 3. Die App ist jetzt ein sauberes, stabiles
 * Diagnose-Tool, das auf die finale Jagd
 * (Schwarzes Loch v3: AA-Handshake) geht.
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
    const liveDashboard = document.getElementById('liveDashboard');
    const networkStatusEl = document.getElementById('networkStatus');
    const wakeLockDashboard = document.getElementById('wakeLockDashboard');
    const wakeLockStatusEl = document.getElementById('wakeLockStatus');
    
    // --- Chart-Kontexte ---
    const gpsChartCtx = document.getElementById('gpsChart')?.getContext('2d');
    const orientationChartCtx = document.getElementById('orientationChart')?.getContext('2d');
    let gpsChart = null;
    let orientationChart = null;
    const CHART_MAX_DATA_POINTS = 50; 
    let v16_chartErrorLogged = false;

    // --- Logger-Status ---
    let isLogging = false;
    let logEntries = [];
    let geoWatchId = null;
    let permissionsState = { gps: false, motion: false, orientation: false, network: false, webrtc: false, wakelock: false };

    // --- WakeLock-API ---
    let wakeLockSentinel = null;

    // --- Netzwerk-Zwei-Zangen-Attacke ---
    let networkCheckInterval = null;
    let lastNetworkType = "unknown";
    let lastOnlineStatus = navigator.onLine;
    const NETWORK_POLL_INTERVAL_MS = 3000;
    let ipSnifferInterval = null;
    let lastLocalIP = "";
    const IP_SNIFFER_INTERVAL_MS = 10000;
    let rtcPeerConnection = null; 

    // --- Chart-Timer & Zustands-Variablen ---
    let chartUpdateInterval = null;
    const CHART_UPDATE_INTERVAL_MS = 1000; // 1 Hz
    let currentGpsAccuracy = 0.0;
    let currentGforce = 0.0;
    let currentOrientation = { beta: 0.0, gamma: 0.0 };

    // --- DEBUG Heartbeat Flags ---
    let motionSensorHasFired = false;
    let orientationSensorHasFired = false;

    // --- Flugschreiber & Jolt Detection ---
    let flightRecorderBuffer = [];
    const FLIGHT_RECORDER_DURATION_MS = 2500;
    const JOLT_THRESHOLD_MS2 = 25.0; 
    const JOLT_COOLDOWN_MS = 5000; 
    let lastJoltTime = 0;

    // --- Hilfsfunktion: Delay ---
    function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

    // --- Universal-Funktion zum Loggen (ins Haupt-Log) ---
    function getTimestamp() { return new Date().toISOString(); }
    const logDebug = (window.logDebug || console.log); // Nutzt unseren Debugger

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

    // --- Flugschreiber-Funktionen ---
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
    // --- CHART-FUNKTIONEN (v18-Logik) ---
    // ===================================
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
        if (gpsChartCtx) {
            gpsChart = new Chart(gpsChartCtx, {
                type: 'line', data: { labels: [], datasets: [
                    { label: 'GPS Genauigkeit (m)', data: [], borderColor: '#03a9f4', backgroundColor: 'rgba(3, 169, 244, 0.3)', fill: false, tension: 0.1, yAxisID: 'yGps' },
                    { label: 'G-Kraft (m/s²)', data: [], borderColor: '#f44336', backgroundColor: 'rgba(244, 67, 54, 0.3)', fill: false, tension: 0.1, yAxisID: 'yGforce' }
                ]},
                options: { scales: { x: { display: false }, yGps: { type: 'linear', position: 'left', title: { display: true, text: 'GPS (m)' }, ticks: { color: '#03a9f4' } }, yGforce: { type: 'linear', position: 'right', title: { display: true, text: 'G-Kraft' }, ticks: { color: '#f44336' }, grid: { drawOnChartArea: false } } }, animation: { duration: 0 }, maintainAspectRatio: false }
            });
        }
        if (orientationChartCtx) {
            orientationChart = new Chart(orientationChartCtx, {
                type: 'bar', data: { labels: ['Neigung (X)', 'Seitenneigung (Y)'], datasets: [ { label: 'Grad', data: [0, 0], backgroundColor: ['#bb86fc', '#03dac6'], borderWidth: 1 } ]},
                options: { indexAxis: 'y', scales: { x: { min: -90, max: 90 }, y: { display: false } }, animation: { duration: 0 }, maintainAspectRatio: false, plugins: { legend: { display: false } } }
            });
        }
    }
    function destroyCharts() {
        if (gpsChart) { gpsChart.destroy(); gpsChart = null; }
        if (orientationChart) { orientationChart.destroy(); orientationChart = null; }
        if (chartUpdateInterval) { clearInterval(chartUpdateInterval); chartUpdateInterval = null; }
    }
    function addDataToChart(chart, label, dataArray) {
        if (!chart) return;
        chart.data.labels.push(label);
        dataArray.forEach((value, index) => { chart.data.datasets[index].data.push(value); });
        if (chart.data.labels.length > CHART_MAX_DATA_POINTS) {
            chart.data.labels.shift();
            chart.data.datasets.forEach(dataset => { dataset.data.shift(); });
        }
        chart.update();
    }
    function updateBarChart(chart, dataArray) {
        if (!chart) return;
        chart.data.datasets[0].data = dataArray;
        chart.update();
    }
    function updateCharts() {
        if (!isLogging) return;
        const timeLabel = getTimestamp().slice(11, 19);
        addDataToChart(gpsChart, timeLabel, [ currentGpsAccuracy, currentGforce ]);
        updateBarChart(orientationChart, [ currentOrientation.beta, currentOrientation.gamma ]);
        currentGforce = 0.0; 
    }

    // ===================================
    // --- SENSOR-HANDLER (v20) ---
    // ===================================

    // 1. GPS-Erfolg
    function logPosition(position) { 
        const coords = position.coords;
        const speedKmh = (coords.speed ? coords.speed * 3.6 : 0).toFixed(1);
        const accuracy = coords.accuracy;
        const logData = [ `GPS-OK | Acc: ${accuracy.toFixed(1)}m`, `Speed: ${speedKmh} km/h` ];
        addLogEntry(logData.join(' | '));
        statusEl.textContent = `LOGGING... (GPS: ${accuracy.toFixed(1)}m)`;
        currentGpsAccuracy = accuracy;
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
    
    // 3. Netzwerk-Wächter (Polling)
    function checkNetworkState(isInitialCall = false) {
        if (!permissionsState.network) return; 
        try {
            const isOnline = navigator.onLine;
            let currentType = 'unknown';
            if (!isOnline) { currentType = 'offline'; }
            else { const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
                currentType = connection ? connection.type : 'cellular'; }
            
            if (!isOnline) {
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

    // 4. IP-Sniffer (Polling)
    function checkLocalIP() {
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

    // 5. Bewegungssensor
    function logDeviceMotion(event) {
        const now = Date.now();
        const acc = event.accelerationIncludingGravity;
        if (!motionSensorHasFired) {
            motionSensorHasFired = true;
            if (!acc || acc.x === null) { addLogEntry("DEBUG: 'devicemotion' feuert, ABER DATEN SIND NULL.", 'warn'); }
            else { addLogEntry("DEBUG: 'devicemotion' feuert erfolgreich mit Daten.", 'info'); }
        }
        if (!acc || acc.x === null) return; 
        
        const dataString = `X: ${acc.x.toFixed(2)} | Y: ${acc.y.toFixed(2)} | Z: ${acc.z.toFixed(2)}`;
        pushToFlightRecorder(now, 'MOTION', dataString);
        
        const gForce = Math.sqrt(acc.x**2 + acc.y**2 + acc.z**2);
        currentGforce = gForce;
        
        if (gForce > JOLT_THRESHOLD_MS2 && (now - lastJoltTime > JOLT_COOLDOWN_MS)) {
            lastJoltTime = now;
            const reason = `HARTER STOSS ERKANNT (G-Force: ${gForce.toFixed(1)})`;
            dumpFlightRecorder(getTimestamp(), reason);
        }
    }

    // 6. Orientierungssensor
    function logDeviceOrientation(event) {
        const now = Date.now();
        if (!orientationSensorHasFired) {
            orientationSensorHasFired = true;
            if (event.alpha === null) { addLogEntry("DEBUG: 'deviceorientation' feuert, ABER DATEN SIND NULL.", 'warn'); }
            else { addLogEntry("DEBUG: 'deviceorientation' feuert erfolgreich mit Daten.", 'info'); }
        }
        if (event.alpha === null) return;
        
        const dataString = `Alpha(Z): ${event.alpha.toFixed(1)} | Beta(X): ${event.beta.toFixed(1)} | Gamma(Y): ${event.gamma.toFixed(1)}`;
        pushToFlightRecorder(now, 'ORIENTATION', dataString);
        
        currentOrientation = { beta: event.beta, gamma: event.gamma };
    }
    
    // 7. "Anti-Schlaf-Hack" (Wake Lock API)
    async function startWakeLock() {
        if (!permissionsState.wakelock) {
            addLogEntry("DEBUG: WakeLock-API nicht verfügbar. Überspringe.", 'warn');
            return;
        }
        try {
            wakeLockSentinel = await navigator.wakeLock.request('screen');
            wakeLockDashboard.className = 'dashboard-active';
            wakeLockStatusEl.textContent = 'WAKE LOCK: AKTIV';
            addLogEntry("DEBUG: 'WakeLock (Anti-Schlaf)' erfolgreich angefordert.", 'info');
            
            wakeLockSentinel.onrelease = () => {
                addLogEntry("DEBUG: 'WakeLock' wurde vom System freigegeben (z.B. Tab unsichtbar).", 'warn');
                wakeLockDashboard.className = 'dashboard-offline';
                wakeLockStatusEl.textContent = 'WAKE LOCK: INAKTIV';
            };
        } catch (err) {
            addLogEntry(`FEHLER: 'WakeLock' konnte nicht angefordert werden: ${err.message}`, 'error');
            wakeLockDashboard.className = 'dashboard-offline';
            wakeLockStatusEl.textContent = 'WAKE LOCK: FEHLER';
        }
    }
    
    async function stopWakeLock() {
         if (wakeLockSentinel) {
            try {
                await wakeLockSentinel.release();
                wakeLockSentinel = null;
                addLogEntry("DEBUG: 'WakeLock' (Anti-Schlaf) gestoppt.", 'info');
            } catch (err) {
                addLogEntry(`FEHLER: 'WakeLock' konnte nicht gestoppt werden: ${err.message}`, 'error');
            }
        }
    }


    // ===================================
    // --- STEUERUNGS-FUNKTIONEN (v20) ---
    // ===================================

    // Phase A: Pre-Flight Check (v20 - Bereinigt)
    async function requestAllPermissions() {
        addLogEntry("Phase A: Fordere Berechtigungen an (v20)...");
        statusEl.textContent = "Berechtigungen anfordern...";
        
        // --- WakeLock ---
        if ('wakeLock' in navigator) {
            permissionsState.wakelock = true; addLogEntry("DEBUG: BERECHTIGUNG: WakeLock-API gefunden.");
        } else { addLogEntry("BERECHTIGUNG: WakeLock-API wird nicht unterstützt!", 'warn'); }

        // --- GPS ---
        addLogEntry("DEBUG: Fordere GPS an...");
        try {
            if (!navigator.geolocation) throw new Error("Geolocation wird nicht unterstützt.");
            await new Promise((resolve, reject) => { navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 10000 }); });
            permissionsState.gps = true; addLogEntry("DEBUG: BERECHTIGUNG: GPS erteilt.");
        } catch (err) { addLogEntry(`BERECHTIGUNG: GPS-Fehler (${err.message})`, 'error'); permissionsState.gps = false; }
        
        if (!permissionsState.gps) return false;

        // --- Netzwerk ---
        if ('connection' in navigator || 'mozConnection' in navigator || 'webkitConnection' in navigator) {
            permissionsState.network = true; addLogEntry("DEBUG: BERECHTIGUNG: Netzwerk-API gefunden.");
        } else { addLogEntry("BERECHTIGUNG: Netzwerk-API wird nicht unterstützt!", 'warn'); }

        // --- WebRTC ---
        if ('RTCPeerConnection' in window || 'webkitRTCPeerConnection' in window) {
            permissionsState.webrtc = true; addLogEntry("DEBUG: BERECHTIGUNG: WebRTC-API gefunden.");
        } else { addLogEntry("BERECHTIGUNG: WebRTC-API wird nicht unterstützt!", 'warn'); }
        
        // --- Bewegung ---
        if (typeof(DeviceMotionEvent.requestPermission) === 'function') {
            addLogEntry("DEBUG: 'requestPermission' Motion-API erkannt, fordere an...");
            try {
                const state = await DeviceMotionEvent.requestPermission();
                permissionsState.motion = (state === 'granted');
                addLogEntry(`DEBUG: BERECHTIGUNG: Bewegungssensor-Status: '${state}'`, (state === 'granted' ? 'info' : 'warn'));
            } catch (err) { addLogEntry(`DEBUG: BERECHTIGUNG: Bewegungssensor-Fehler: ${err.message}`, 'error'); permissionsState.motion = false; }
        } else if ('DeviceMotionEvent' in window) {
             permissionsState.motion = true; addLogEntry("DEBUG: BERECHTIGUNG: Bewegungssensor (Implizit/Alt) OK.");
        } else { addLogEntry("BERECHTIGUNG: Bewegungssensor wird nicht unterstützt!", 'error'); permissionsState.motion = false; }

        // --- Orientierung ---
        addLogEntry("DEBUG: Füge kleine Pause ein (500ms)..."); await delay(500); 
        if (typeof(DeviceOrientationEvent.requestPermission) === 'function') {
             addLogEntry("DEBUG: 'requestPermission' Orientation-API erkannt, fordere an...");
            try {
                const state = await DeviceOrientationEvent.requestPermission();
                permissionsState.orientation = (state === 'granted');
                addLogEntry(`DEBUG: BERECHTIGUNG: Orientierungssensor-Status: '${state}'`, (state === 'granted' ? 'info' : 'warn'));
            } catch (err) { addLogEntry(`DEBUG: BERECHTIGUNG: Orientierungssensor-Fehler: ${err.message}`, 'error'); permissionsState.orientation = false; }
        } else if ('DeviceOrientationEvent' in window) {
            permissionsState.orientation = true; addLogEntry("DEBUG: BERECHTIGUNG: Orientierungssensor (Implizit/Alt) OK.");
        } else { addLogEntry("BERECHTIGUNG: Orientierungssensor wird nicht unterstützt!", 'error'); permissionsState.orientation = false; }
        
        addLogEntry("Phase A: Pre-Flight Check beendet.");
        return permissionsState.gps; 
    }

    // Phase B: Startet alle Logger
    async function startAllLoggers() {
        addLogEntry("Phase B: Starte alle Logger (v20)...");
        statusEl.textContent = "LOGGING... (Starte Sensoren)";

        // 1. Wake Lock STARTEN
        await startWakeLock();
        
        // 2. Charts initialisieren
        initCharts();
        
        // 3. Chart-Update-Timer starten
        chartUpdateInterval = setInterval(updateCharts, CHART_UPDATE_INTERVAL_MS);
        addLogEntry(`DEBUG: 'chartUpdateInterval' (1Hz) gestartet.`);
        
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
        downloadBtn.disabled = true; 
    }

    // ===================================
    // --- BUTTON-HANDLER (v20) ---
    // ===================================

    // PRE-FLIGHT CHECK
    permissionBtn.onclick = async () => {
        permissionBtn.disabled = true; startBtn.disabled = true; 
        statusEl.textContent = "Prüfe Berechtigungen...";
        logEntries = []; flightRecorderBuffer = []; logAreaEl.value = "";
        lastNetworkType = "unknown"; lastOnlineStatus = navigator.onLine; lastLocalIP = "";
        permissionsState = { gps: false, motion: false, orientation: false, network: false, webrtc: false, wakelock: false };
        v16_chartErrorLogged = false;
        
        const gpsOk = await requestAllPermissions();

        if (gpsOk) {
            statusEl.textContent = "Bereit zum Loggen! (GPS OK)";
            startBtn.disabled = false; downloadBtn.disabled = true; permissionBtn.disabled = true; 
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
        currentGpsAccuracy = 0.0; currentGforce = 0.0; currentOrientation = { beta: 0.0, gamma: 0.0 };
        
        addLogEntry(`Logging-Prozess angefordert (v20)...`);
        startAllLoggers();
    };

    // STOP
    stopBtn.onclick = async () => {
        if (!isLogging) return;
        
        // Alle Timer und Listener stoppen
        await stopWakeLock(); // v19
        if (geoWatchId) navigator.geolocation.clearWatch(geoWatchId);
        if (networkCheckInterval) clearInterval(networkCheckInterval); 
        if (ipSnifferInterval) clearInterval(ipSnifferInterval);
        if (chartUpdateInterval) clearInterval(chartUpdateInterval); 
        if (rtcPeerConnection) { rtcPeerConnection.close(); rtcPeerConnection = null; }

        window.removeEventListener('devicemotion', logDeviceMotion);
        window.removeEventListener('deviceorientation', logDeviceOrientation);
        
        // Charts zerstören
        destroyCharts();
        
        isLogging = false;
        geoWatchId = null; networkCheckInterval = null; ipSnifferInterval = null; chartUpdateInterval = null;
        flightRecorderBuffer = [];
        addLogEntry("Logging gestoppt.");

        // UI zurücksetzen
        statusEl.textContent = "Status: Gestoppt. Download bereit.";
        startBtn.disabled = true; 
        permissionBtn.disabled = false; 
        stopBtn.disabled = true;
        crashBtn.disabled = true;
        downloadBtn.disabled = false; 
        liveDashboard.className = 'dashboard-unknown';
        networkStatusEl.textContent = 'BEREIT';
        wakeLockDashboard.className = 'dashboard-unknown';
        wakeLockStatusEl.textContent = 'WAKE LOCK: BEREIT';
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
        const filename = `waze_log_v20_${new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-')}.txt`;
        const blob = new Blob([logData], { type: 'text/plain;charset=utf-8' }); 
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
    wakeLockDashboard.className = 'dashboard-unknown';
    wakeLockStatusEl.textContent = 'WAKE LOCK: BEREIT';
}); 
