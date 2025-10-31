/*
 * Waze Korrelations-Logger - v15 "IP-Sniffer"
 * =============================================
 *
 * BASIS: v14 (Stabiler "Anti-Schlaf-Hack")
 *
 * PROBLEM: Der "Netzwerk-Wächter" (v10/v13/v14) ist blind für
 * die Wi-Fi-Direct-Verbindung von AA. Er meldet
 * "cellular", obwohl AA verbunden ist.
 *
 * NEU in v15:
 * 1. Wir starten ZWEI Polling-Timer:
 * a) Der `NetworkInformation.type` Poller (v14) bleibt
 * aktiv (fürs Dashboard, auch wenn er "lügt").
 * b) Ein NEUER "IP-Sniffer" (v15) Poller (alle 10s).
 * 2. Der IP-Sniffer nutzt den "WebRTC-Hack", um zu
 * versuchen, die *lokale IP-Adresse* zu finden.
 * 3. Wenn er eine lokale IP (192.168.x.x etc.) findet,
 * loggt er diese. Dies ist unser "Rauchender Colt"
 * für den AA-Handshake.
 * 4. Wir behalten den (nutzlosen) v14-Netzwerk-Check
 * im Code, um zu sehen, ob er *doch* irgendwann
 * aufwacht, jetzt da die App wach bleibt.
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

    // --- Logger-Status ---
    let isLogging = false;
    let logEntries = [];
    let geoWatchId = null;
    let permissionsState = { gps: false, motion: false, orientation: false, network: false, webrtc: false };

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
    const IP_SNIFFER_INTERVAL_MS = 10000; // Alle 10 Sekunden
    let rtcPeerConnection = null; // Für den Sniffer

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
    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

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
    // --- SENSOR-HANDLER (v15) ---
    // ===================================

    // 1. GPS-Erfolg
    function logPosition(position) { 
        const coords = position.coords;
        const speedKmh = (coords.speed ? coords.speed * 3.6 : 0).toFixed(1);
        const logData = [ `GPS-OK | Acc: ${coords.accuracy.toFixed(1)}m`, `Speed: ${speedKmh} km/h` ];
        addLogEntry(logData.join(' | '));
        statusEl.textContent = `LOGGING... (GPS: ${coords.accuracy.toFixed(1)}m)`;
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
        if (!permissionsState.network) return; 
        try {
            const isOnline = navigator.onLine;
            let currentType = 'unknown';
            if (!isOnline) { currentType = 'offline'; }
            else { const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
                currentType = connection ? connection.type : 'cellular'; }
            
            // Dashboard-Logik
            if (currentType === 'offline') {
                liveDashboard.className = 'dashboard-offline'; networkStatusEl.textContent = 'STATUS: OFFLINE';
            } else if (currentType === 'wifi') {
                liveDashboard.className = 'dashboard-wifi'; networkStatusEl.textContent = 'NETZ: WIFI (VERBUNDEN?)';
            } else if (currentType === 'cellular') {
                liveDashboard.className = 'dashboard-cellular'; networkStatusEl.textContent = 'NETZ: MOBILFUNK';
            } else {
                liveDashboard.className = 'dashboard-unknown'; networkStatusEl.textContent = `NETZ: ${currentType.toUpperCase()}`;
            }

            // Log-File-Logik (nur bei Änderung)
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
    // Der "schmutzige" WebRTC-Hack
    function checkLocalIP() {
        if (!permissionsState.webrtc) return;

        try {
            // Alte Verbindung schließen, falls vorhanden
            if (rtcPeerConnection) { rtcPeerConnection.close(); rtcPeerConnection = null; }

            const PeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection;
            const rtc = new PeerConnection({ iceServers: [] });
            rtcPeerConnection = rtc; // Global speichern, um es später zu schließen
            
            rtc.createDataChannel(''); // Dummy-Kanal
            
            // Höre auf "ICE Candidates" (IP-Adressen)
            rtc.onicecandidate = (event) => {
                if (event.candidate && event.candidate.candidate) {
                    // Wir haben einen Kandidaten, jetzt die IP extrahieren
                    const ipRegex = /(192\.168\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[0-1])\.[0-9]{1,3}\.[0-9]{1,3}|10\.[0-9]{1,3}\.[0-9]{1,3})/g;
                    const match = ipRegex.exec(event.candidate.candidate);
                    
                    if (match) {
                        const newLocalIP = match[0];
                        if (newLocalIP !== lastLocalIP) {
                            addLogEntry(`IP-SNIFFER: Lokale IP-Änderung! Neue IP: ${newLocalIP}`, 'warn');
                            lastLocalIP = newLocalIP;
                        }
                        // Verbindung sofort schließen, wir haben, was wir brauchen
                        if (rtc) { rtc.close(); rtcPeerConnection = null; }
                    }
                }
            };
            
            // Angebot erstellen, um den 'onicecandidate'-Prozess auszulösen
            rtc.createOffer()
                .then(offer => rtc.setLocalDescription(offer))
                .catch(err => addLogEntry(`IP-SNIFFER: Fehler beim Erstellen des Offers: ${err.message}`, 'error'));

        } catch (err) {
            addLogEntry(`IP-SNIFFER: Kritischer Fehler: ${err.message}`, 'error');
            permissionsState.webrtc = false; // API scheint kaputt zu sein, stoppen
            if (ipSnifferInterval) clearInterval(ipSnifferInterval);
        }
    }

    // 5. Bewegungssensor
    function logDeviceMotion(event) {
        // (Identisch zu v14)
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
        if (gForce > JOLT_THRESHOLD_MS2 && (now - lastJoltTime > JOLT_COOLDOWN_MS)) {
            lastJoltTime = now;
            const reason = `HARTER STOSS ERKANNT (G-Force: ${gForce.toFixed(1)})`;
            dumpFlightRecorder(getTimestamp(), reason);
        }
    }

    // 6. Orientierungssensor
    function logDeviceOrientation(event) {
        // (Identisch zu v14)
        const now = Date.now();
        if (!orientationSensorHasFired) {
            orientationSensorHasFired = true;
            if (event.alpha === null) { addLogEntry("DEBUG: 'deviceorientation' feuert, ABER DATEN SIND NULL.", 'warn'); }
            else { addLogEntry("DEBUG: 'deviceorientation' feuert erfolgreich mit Daten.", 'info'); }
        }
        if (event.alpha === null) return;
        const dataString = `Alpha(Z): ${event.alpha.toFixed(1)} | Beta(X): ${event.beta.toFixed(1)} | Gamma(Y): ${event.gamma.toFixed(1)}`;
        pushToFlightRecorder(now, 'ORIENTATION', dataString);
    }
    
    // 7. v14: Anti-Schlaf-Hack (Stilles Audio)
    function startAntiSleepAudio() {
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
         try {
            if (antiSleepOscillator) { antiSleepOscillator.stop(); antiSleepOscillator = null; }
            if (antiSleepContext) { antiSleepContext.close(); antiSleepContext = null; }
            addLogEntry("DEBUG: 'Anti-Schlaf-Hack' (Stilles Audio) gestoppt.", 'info');
         } catch (e) { addLogEntry(`FEHLER: 'Anti-Schlaf-Hack' konnte nicht gestoppt werden: ${e.message}`, 'error'); }
    }

    // ===================================
    // --- STEUERUNGS-FUNKTIONEN (v15) ---
    // ===================================

    // Phase A: Pre-Flight Check (v15)
    async function requestAllPermissions() {
        addLogEntry("Phase A: Fordere Berechtigungen an (v15)...");
        statusEl.textContent = "Berechtigungen anfordern...";
        const useFallback = fallbackToggle.checked;
        if (useFallback) { addLogEntry("DEBUG v15: 'Alte API erzwingen' ist AKTIV. Überspringe 'requestPermission'.", 'warn'); }

        // --- GPS ---
        addLogEntry("DEBUG v15: Fordere GPS an...");
        try {
            if (!navigator.geolocation) throw new Error("Geolocation wird nicht unterstützt.");
            await new Promise((resolve, reject) => { navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 10000 }); });
            permissionsState.gps = true; addLogEntry("DEBUG v15: BERECHTIGUNG: GPS erteilt.");
        } catch (err) { addLogEntry(`BERECHTIGUNG: GPS-Fehler (${err.message})`, 'error'); permissionsState.gps = false; }
        addLogEntry("DEBUG v15: GPS-Anfrage abgeschlossen.");

        // --- Netzwerk (v14-Stil) ---
        addLogEntry("DEBUG v15: Prüfe Netzwerk-API...");
        if ('connection' in navigator || 'mozConnection' in navigator || 'webkitConnection' in navigator) {
            permissionsState.network = true; addLogEntry("DEBUG v15: BERECHTIGUNG: Netzwerk-API gefunden.");
        } else { addLogEntry("BERECHTIGUNG: Netzwerk-API wird nicht unterstützt!", 'warn'); }

        // --- WebRTC (v15-Stil) ---
        addLogEntry("DEBUG v15: Prüfe WebRTC-API (IP-Sniffer)...");
        if ('RTCPeerConnection' in window || 'webkitRTCPeerConnection' in window) {
            permissionsState.webrtc = true; addLogEntry("DEBUG v15: BERECHTIGUNG: WebRTC-API gefunden.");
        } else { addLogEntry("BERECHTIGUNG: WebRTC-API wird nicht unterstützt!", 'warn'); }
        addLogEntry("DEBUG v15: Netzwerk-Checks abgeschlossen.");
        
        // --- Bewegung ---
        addLogEntry("DEBUG v15: Prüfe Bewegungssensor...");
        if (useFallback) {
            permissionsState.motion = true; addLogEntry("DEBUG v15: BERECHTIGUNG: Bewegungssensor (Fallback erzwungen) OK.");
        } else if (typeof(DeviceMotionEvent.requestPermission) === 'function') {
            addLogEntry("DEBUG v15: 'requestPermission' Motion-API erkannt, fordere an...");
            try {
                const state = await DeviceMotionEvent.requestPermission();
                permissionsState.motion = (state === 'granted');
                addLogEntry(`DEBUG v15: BERECHTIGUNG: Bewegungssensor-Status: '${state}'`, (state === 'granted' ? 'info' : 'warn'));
            } catch (err) { addLogEntry(`DEBUG v15: BERECHTIGUNG: Bewegungssensor-Fehler: ${err.message}`, 'error'); permissionsState.motion = false; }
        } else if ('DeviceMotionEvent' in window) {
             permissionsState.motion = true; addLogEntry("DEBUG v15: BERECHTIGUNG: Bewegungssensor (Implizit/Alt) OK.");
        } else { addLogEntry("BERECHTIGUNG: Bewegungssensor wird nicht unterstützt!", 'error'); permissionsState.motion = false; }
        addLogEntry("DEBUG v15: Bewegungssensor-Check abgeschlossen.");

        // --- Orientierung ---
        addLogEntry("DEBUG v15: Füge kleine Pause ein (500ms)..."); await delay(500); 
        addLogEntry("DEBUG v15: Prüfe Orientierungssensor...");
        if (useFallback) {
             permissionsState.orientation = true; addLogEntry("DEBUG v15: BERECHTIGUNG: Orientierungssensor (Fallback erzwungen) OK.");
        } else if (typeof(DeviceOrientationEvent.requestPermission) === 'function') {
             addLogEntry("DEBUG v15: 'requestPermission' Orientation-API erkannt, fordere an...");
            try {
                const state = await DeviceOrientationEvent.requestPermission();
                permissionsState.orientation = (state === 'granted');
                addLogEntry(`DEBUG v15: BERECHTIGUNG: Orientierungssensor-Status: '${state}'`, (state === 'granted' ? 'info' : 'warn'));
            } catch (err) { addLogEntry(`DEBUG v15: BERECHTIGUNG: Orientierungssensor-Fehler: ${err.message}`, 'error'); permissionsState.orientation = false; }
        } else if ('DeviceOrientationEvent' in window) {
            permissionsState.orientation = true; addLogEntry("DEBUG v15: BERECHTIGUNG: Orientierungssensor (Implizit/Alt) OK.");
        } else { addLogEntry("BERECHTIGUNG: Orientierungssensor wird nicht unterstützt!", 'error'); permissionsState.orientation = false; }
        addLogEntry("DEBUG v15: Orientierungssensor-Check abgeschlossen.");
        
        addLogEntry("Phase A: Pre-Flight Check beendet.");
        return permissionsState.gps; 
    }

    // Phase B: Startet alle Logger (v15)
    function startAllLoggers() {
        addLogEntry("Phase B: Starte alle Logger (v15)...");
        statusEl.textContent = "LOGGING... (Starte Sensoren)";

        // 1. Anti-Schlaf-Audio STARTEN
        startAntiSleepAudio();
        
        // 2. GPS-Logger
        const geoOptions = { enableHighAccuracy: true, timeout: 10000, maximumAge: 1000 };
        geoWatchId = navigator.geolocation.watchPosition(logPosition, logError, geoOptions);
        addLogEntry("DEBUG: 'geolocation.watchPosition' Listener angehängt.");
        
        // 3. Netzwerk-Wächter (Zange 1)
        if (permissionsState.network) {
            networkCheckInterval = setInterval(checkNetworkState, NETWORK_POLL_INTERVAL_MS);
            addLogEntry(`DEBUG: Netzwerk-Wächter (Typ) Polling gestartet (Intervall: ${NETWORK_POLL_INTERVAL_MS}ms).`);
            checkNetworkState(true); 
        }
        
        // 4. IP-Sniffer (Zange 2)
        if (permissionsState.webrtc) {
            ipSnifferInterval = setInterval(checkLocalIP, IP_SNIFFER_INTERVAL_MS);
            addLogEntry(`DEBUG: IP-Sniffer (WebRTC) Polling gestartet (Intervall: ${IP_SNIFFER_INTERVAL_MS}ms).`);
            checkLocalIP(); // Sofortiger erster Check
        }

        // 5. Bewegungs-Sensor-Logger
        if (permissionsState.motion) {
            window.addEventListener('devicemotion', logDeviceMotion);
            addLogEntry("DEBUG: 'devicemotion' Listener angehängt.");
        } else { addLogEntry("WARNUNG: Bewegungssensor-Listener NICHT angehängt.", 'warn'); }
        
        // 6. Orientierungs-Sensor-Logger
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
    // --- BUTTON-HANDLER (v15) ---
    // ===================================

    // PRE-FLIGHT CHECK
    permissionBtn.onclick = async () => {
        permissionBtn.disabled = true; startBtn.disabled = true; 
        statusEl.textContent = "Prüfe Berechtigungen...";
        logEntries = []; flightRecorderBuffer = []; logAreaEl.value = "";
        lastNetworkType = "unknown"; lastOnlineStatus = navigator.onLine; lastLocalIP = "";
        permissionsState = { gps: false, motion: false, orientation: false, network: false, webrtc: false };
        
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
        
        addLogEntry(`Logging-Prozess angefordert (v15)...`);
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
        const filename = `waze_log_v15_${new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-')}.txt`;
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
