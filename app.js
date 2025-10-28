/* Das ist die "Controller"-Schicht - unsere Logik */

// Strikten Modus verwenden, um sauberen Code zu erzwingen
"use strict";

// --- DOM-Elemente sicher abrufen ---
// Wir warten, bis das gesamte HTML geladen ist, bevor wir die Elemente suchen
document.addEventListener("DOMContentLoaded", () => {
    
    // --- DOM-Elemente ---
    const statusEl = document.getElementById('status');
    const logAreaEl = document.getElementById('logArea');
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    const crashBtn = document.getElementById('crashBtn');
    const downloadBtn = document.getElementById('downloadBtn');

    // --- Logger-Status ---
    let isLogging = false;
    let logEntries = [];
    let geoWatchId = null;

    // --- Universal-Funktion zum Loggen ---
    function getTimestamp() {
        return new Date().toISOString();
    }

    function addLogEntry(message, level = 'info') {
        const logString = `${getTimestamp()} | ${message}`;
        logEntries.push(logString);

        // Log-Level in der Konsole ausgeben (für Debugging)
        if (level === 'error') console.error(logString);
        else if (level === 'warn') console.warn(logString);
        else console.log(logString);

        // Textfeld aktualisieren
        updateLogDisplay();
    }

    function updateLogDisplay() {
        // Nur die letzten 100 Zeilen anzeigen, um Leistung zu sparen
        logAreaEl.value = logEntries.slice(-100).join('\n');
        logAreaEl.scrollTop = logAreaEl.scrollHeight; // Auto-Scroll
    }

    // --- Sensor-Handler (Das Herzstück) ---

    // 1. GPS-Erfolg
    function logPosition(position) {
        const coords = position.coords;
        const isOnline = navigator.onLine;
        
        // Geschwindigkeit von m/s in km/h umrechnen (oder 0 anzeigen)
        const speedKmh = (coords.speed ? coords.speed * 3.6 : 0).toFixed(1);

        const logData = [
            `GPS-OK | Acc: ${coords.accuracy.toFixed(1)}m`,
            `Speed: ${speedKmh} km/h`,
            `Online: ${isOnline}`,
            `Lat: ${coords.latitude.toFixed(5)}`,
            `Lng: ${coords.longitude.toFixed(5)}`
        ];
        
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

    // 3. Audio/Bluetooth-Geräte-Änderung
    function logDeviceChange() {
        addLogEntry('BT/AUDIO-EVENT: Geräte-Änderung erkannt!', 'warn');
        // Wir aktualisieren sofort die Geräteliste
        updateDeviceList();
    }

    // 4. Geräteliste auslesen (Versuch)
    async function updateDeviceList() {
        try {
            // Prüfen, ob die API überhaupt existiert
            if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
                addLogEntry("BT/AUDIO-FEHLER: MediaDevices API nicht unterstützt.", 'error');
                return;
            }

            // Trick: Berechtigung für Mikrofon anfragen, um detaillierte Labels zu erhalten.
            // Ohne das sind die Labels aus Datenschutzgründen oft leer.
            // Wir müssen den Stream nicht mal benutzen, nur anfragen.
            try {
                // Wir nutzen .getUserMedia nur, wenn es noch nicht erteilt wurde
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                // Stream sofort wieder stoppen, wir brauchen ihn nicht, nur die Berechtigung
                stream.getTracks().forEach(track => track.stop());
            } catch (permErr) {
                // Nutzer hat Berechtigung verweigert
                addLogEntry("BT/AUDIO-INFO: Mikrofon-Zugriff verweigert, Gerätelabels könnten fehlen.", 'warn');
            }

            const devices = await navigator.mediaDevices.enumerateDevices();
            let audioOutputs = [];
            devices.forEach(device => {
                if (device.kind === 'audiooutput') {
                    // Label loggen, oder 'Unbenannt' wenn leer
                    audioOutputs.push(device.label || 'Unbenanntes Gerät');
                }
            });
            
            const logString = `BT/AUDIO-STATUS: ${audioOutputs.length} Audio-Ausgänge | Namen: [${audioOutputs.join(', ')}]`;
            addLogEntry(logString, 'info');

        } catch (err) {
            addLogEntry(`BT/AUDIO-FEHLER: ${err.message}`, 'error');
        }
    }


    // --- Button-Handler ---

    // START
    startBtn.onclick = () => {
        // Prüfen, ob die APIs da sind
        if (!navigator.geolocation) {
            alert("Fehler: Geolocation wird nicht unterstützt.");
            return;
        }
        if (!navigator.mediaDevices) {
            alert("Fehler: MediaDevices (für Bluetooth) wird nicht unterstützt.");
        }

        isLogging = true;
        logEntries = []; // Altes Log leeren
        logAreaEl.value = "";
        addLogEntry("Logging gestartet...");

        // UI-Status
        statusEl.textContent = "LOGGING... (Suche GPS)";
        startBtn.disabled = true;
        stopBtn.disabled = false;
        crashBtn.disabled = false;
        downloadBtn.disabled = true;

        // 1. GPS-Logger starten
        const geoOptions = { enableHighAccuracy: true, timeout: 10000, maximumAge: 1000 };
        geoWatchId = navigator.geolocation.watchPosition(logPosition, logError, geoOptions);

        // 2. BT/Audio-Logger starten (falls vorhanden)
        if (navigator.mediaDevices) {
            navigator.mediaDevices.ondevicechange = logDeviceChange;
            updateDeviceList(); // Initialen Status loggen
        }
    };

    // STOP
    stopBtn.onclick = () => {
        if (!isLogging) return;
        
        // 1. GPS-Logger stoppen
        if (geoWatchId) {
            navigator.geolocation.clearWatch(geoWatchId);
            geoWatchId = null;
        }
        
        // 2. BT/Audio-Logger stoppen
        if (navigator.mediaDevices) {
            navigator.mediaDevices.ondevicechange = null;
        }
        
        isLogging = false;
        addLogEntry("Logging gestoppt.");

        // UI-Status
        statusEl.textContent = "Status: Gestoppt. Download bereit.";
        startBtn.disabled = false;
        stopBtn.disabled = true;
        crashBtn.disabled = true;
        downloadBtn.disabled = false; // Download freischalten!
    };

    // ABSTURZ MARKIEREN
    crashBtn.onclick = () => {
        if (!isLogging) return;
        addLogEntry("\n--- !!! ABSTURZ VOM NUTZER MARKIERT !!! ---\n", 'warn');
        
        // Visuelles Feedback
        statusEl.textContent = "ABSTURZ MARKIERT!";
        setTimeout(() => {
            if(isLogging) {
                // Status zurücksetzen, aber nur wenn wir noch loggen
                statusEl.textContent = "LOGGING...";
            }
        }, 2000);
    };

    // DOWNLOAD
    downloadBtn.onclick = () => {
        if (logEntries.length === 0) {
            alert("Keine Logs zum Herunterladen vorhanden.");
            return;
        }

        // Gesamtes Log als Text-String
        const logData = logEntries.join('\n');
        // Als Blob (Binärdatei) erstellen
        const blob = new Blob([logData], { type: 'text/plain' });

        // Dateinamen mit Zeitstempel erstellen
        const filename = `waze_log_${new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-')}.txt`;

        // Temporären Download-Link erstellen und klicken
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        
        document.body.appendChild(a); // Nötig für Firefox
        a.click();
        document.body.removeChild(a); // Aufräumen
    };
});

 
