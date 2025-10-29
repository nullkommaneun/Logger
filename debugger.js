/*
 * SYSTEM-DEBUGGER v1
 * ==================
 * Dein "Sicherungskasten".
 * Diese Datei MUSS als ERSTES in der index.html geladen werden.
 *
 * 1. Fängt globale JavaScript-Fehler (von app.js etc.)
 * 2. Prüft das System (HTTPS, APIs) auf "Herz und Nieren".
 */
"use strict";

(function() {
    // Ein Puffer, falls das DOM noch nicht bereit ist
    let debugMessages = [];

    // --- 1. Der globale Fehler-Fänger ---
    // Dieser Haken fängt JEDEN Fehler, der nach ihm auftritt
    // (z.B. Syntaxfehler in app.js)
    window.onerror = function(message, source, lineno, colno, error) {
        const errorMsg = `
--- !!! GLOBALER FEHLER GEFANGEN !!! ---
FEHLER: ${message}
QUELLE: ${source}
ZEILE: ${lineno}, SPALTE: ${colno}
DETAILS: ${error ? error.stack : 'Nicht verfügbar'}
--- ENDE FEHLER ---
`;
        console.error(errorMsg); // Auch in der echten Konsole loggen
        logDebug(errorMsg);
        return true; // Verhindert, dass der Browser-Standard-Fehlerdialog kommt
    };

    // --- 2. Der System-Check ("Herz und Nieren") ---
    function runSystemCheck() {
        logDebug("--- SYSTEM-CHECK (Herz und Nieren) ---");
        
        // Check 1: HTTPS (Kritisch für alle APIs)
        if (window.location.protocol !== 'https:'){
            logDebug("KRITISCHER FEHLER: Seite ist NICHT über HTTPS geladen!");
            logDebug("     -> APIs (GPS, Sensoren) werden FEHLSCHLAGEN.");
        } else {
            logDebug("SYSTEM-CHECK: HTTPS ... OK");
        }

        // Check 2: Browser
        logDebug(`SYSTEM-CHECK: User Agent ... ${navigator.userAgent}`);

        // Check 3: API-Verfügbarkeit
        checkApi('Geolocation', navigator.geolocation);
        checkApi('MediaDevices (Audio/BT)', navigator.mediaDevices);
        checkApi('DeviceMotionEvent (Bewegung)', window.DeviceMotionEvent);
        checkApi('DeviceOrientationEvent (Ausrichtung)', window.DeviceOrientationEvent);

        // Check 4: iOS-spezifische API-Checks
        if (window.DeviceMotionEvent && typeof DeviceMotionEvent.requestPermission === 'function') {
            logDebug("SYSTEM-CHECK: iOS-spezifische Motion-API ... GEFUNDEN");
        }
        if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function') {
            logDebug("SYSTEM-CHECK: iOS-spezifische Orientation-API ... GEFUNDEN");
        }
        
        logDebug("--- SYSTEM-CHECK BEENDET ---");
    }

    function checkApi(name, api) {
        if (api) {
            logDebug(`SYSTEM-CHECK: API '${name}' ... VERFÜGBAR`);
        } else {
            logDebug(`SYSTEM-CHECK: API '${name}' ... NICHT VERFÜGBAR!`, 'error');
        }
    }

    // --- Hilfsfunktionen für die Ausgabe ---
    function logDebug(message, level = 'info') {
        const timestamp = new Date().toISOString().split('T')[1].replace('Z', '');
        const logLine = `[${timestamp}] ${message}`;
        
        const outputEl = document.getElementById('debug-output');
        if (outputEl) {
            outputEl.textContent += logLine + '\n';
        } else {
            debugMessages.push(logLine); // Speichern für später
        }
    }

    // --- Start & UI-Hooks ---
    window.addEventListener('DOMContentLoaded', () => {
        const outputEl = document.getElementById('debug-output');
        const copyBtn = document.getElementById('copyDebugBtn');

        // Initialisiere das Debug-Fenster
        outputEl.textContent = "Debugger v1 initialisiert...\n";
        
        // Schreibe gepufferte Nachrichten (falls vorhanden)
        if (debugMessages.length > 0) {
            outputEl.textContent += debugMessages.join('\n') + '\n';
            debugMessages = []; // Puffer leeren
        }

        // Führe den System-Check aus
        try {
            runSystemCheck();
        } catch (e) {
            logDebug(`FEHLER WÄHREND SYSTEM-CHECK: ${e.message}`, 'error');
        }

        // Programmiere den Kopier-Button
        if (copyBtn) {
            copyBtn.onclick = () => {
                try {
                    // Verwende die execCommand-Methode für maximale Kompatibilität in iFrames
                    const tempText = document.createElement("textarea");
                    document.body.appendChild(tempText);
                    tempText.value = outputEl.textContent;
                    tempText.select();
                    document.execCommand("copy");
                    document.body.removeChild(tempText);
                    
                    copyBtn.textContent = "Kopiert!";
                    setTimeout(() => { copyBtn.textContent = "Debug-Log kopieren"; }, 2000);
                } catch (e) {
                    copyBtn.textContent = "Fehler beim Kopieren!";
                    console.error("Kopieren fehlgeschlagen: ", e);
                }
            };
        }
    });

})(); // Selbstausführende Funktion, um den globalen Scope sauber zu halten

