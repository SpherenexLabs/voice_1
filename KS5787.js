(() => {
    'use strict';

    const FIREBASE_BASE = 'https://diet-planner-3bdf3-default-rtdb.firebaseio.com/5787';
    const PASSWORD_ITERATIONS = 150000;
    const $ = id => document.getElementById(id);
    const pad = value => String(value).padStart(2, '0');
    const localDate = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const today = () => localDate(new Date());
    const safe = value => String(value).replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[character]));
    const makeId = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    let reminders = [];
    let reminderHistory = [];
    let user = '';
    let pendingUser = null;
    let currentUserKey = '';
    let view = 'dashboard';
    let editing = null;
    let voiceState = '';
    let draft = {};
    let voiceCandidate = '';
    let recognition = null;
    let reminderStream = null;
    let refreshTimer = null;
    let faceStream = null;
    let faceEnrollmentImage = '';
    let faceEnrollmentDescriptor = null;
    let loginFaceStream = null;
    let pendingLoginAccount = null;
    let pendingLoginKey = '';
    let pendingFaceEnrollmentMode = false;
    let faceModelsPromise = null;
    let speechSequence = 0;
    let listeningSession = 0;
    let voiceNoSpeechAttempts = 0;
    let voiceListening = false;
    let pendingAcknowledgement = null;
    const FACE_MODEL_URL = 'https://cdn.jsdelivr.net/gh/vladmandic/face-api@1.7.12/model';
    const FACE_MATCH_THRESHOLD = 0.55;

    async function firebaseRequest(path = '', options = {}) {
        const response = await fetch(`${FIREBASE_BASE}${path}.json`, {
            ...options,
            headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
        });
        if (!response.ok) throw new Error(`Firebase request failed (${response.status})`);
        return response.status === 204 ? null : response.json();
    }

    function setFirebaseStatus(state, detail = '') {
        const message = state === 'online' ? 'Firebase live' : state === 'offline' ? `Firebase unavailable${detail ? `: ${detail}` : ''}` : 'Firebase connecting';
        [$('firebaseStatus'), $('syncStatus')].forEach(status => {
            status.classList.remove('online', 'offline');
            if (state) status.classList.add(state);
            status.textContent = message;
        });
    }

    async function checkFirebase() {
        try {
            await firebaseRequest('/health');
            setFirebaseStatus('online');
        } catch (error) {
            setFirebaseStatus('offline', error.message);
        }
    }

    function bytesToBase64(bytes) {
        return btoa(String.fromCharCode(...bytes));
    }

    function base64ToBytes(value) {
        return Uint8Array.from(atob(value), character => character.charCodeAt(0));
    }

    async function sha256Hex(value) {
        if (!crypto.subtle) throw new Error('Secure password processing requires HTTPS or localhost.');
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
        return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    }

    async function userKey(username) {
        return sha256Hex(username.trim().toLowerCase());
    }

    async function derivePassword(password, saltBase64, iterations = PASSWORD_ITERATIONS) {
        if (!crypto.subtle) throw new Error('Secure password processing requires HTTPS or localhost.');
        const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
        const bits = await crypto.subtle.deriveBits({
            name: 'PBKDF2',
            salt: base64ToBytes(saltBase64),
            iterations,
            hash: 'SHA-256'
        }, material, 256);
        return bytesToBase64(new Uint8Array(bits));
    }

    function hashesMatch(left = '', right = '') {
        if (left.length !== right.length) return false;
        let difference = 0;
        for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
        return difference === 0;
    }

    function normalizeReminders(value) {
        if (!value || typeof value !== 'object') return [];
        return (Array.isArray(value) ? value : Object.values(value)).filter(item => item && typeof item === 'object');
    }

    async function loadReminders() {
        if (!currentUserKey) return;
        reminders = normalizeReminders(await firebaseRequest(`/reminders/${currentUserKey}`));
        render();
        setFirebaseStatus('online');
    }

    async function loadReminderHistory() {
        if (!currentUserKey) return;
        reminderHistory = normalizeReminders(await firebaseRequest(`/reminderHistory/${currentUserKey}`))
            .sort((left, right) => String(right.timestamp).localeCompare(String(left.timestamp)));
        render();
    }

    async function recordReminderHistory(reminder, action, details = '') {
        if (!currentUserKey || !reminder) return;
        const entry = {
            id: makeId(),
            reminderId: reminder.id || '',
            title: reminder.title || 'Reminder',
            action,
            details,
            scheduledDate: reminder.date || '',
            scheduledTime: reminder.time || '',
            repeat: reminder.repeat || 'once',
            timestamp: new Date().toISOString()
        };
        await firebaseRequest(`/reminderHistory/${currentUserKey}/${entry.id}`, {
            method: 'PUT',
            body: JSON.stringify(entry)
        });
        reminderHistory.unshift(entry);
        if (view === 'history') render();
    }

    function scheduleReminderRefresh() {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => loadReminders().catch(error => setFirebaseStatus('offline', error.message)), 120);
    }

    function startReminderStream() {
        reminderStream?.close();
        if (!currentUserKey || !('EventSource' in window)) return;
        reminderStream = new EventSource(`${FIREBASE_BASE}/reminders/${currentUserKey}.json`);
        reminderStream.addEventListener('open', () => setFirebaseStatus('online'));
        reminderStream.addEventListener('put', scheduleReminderRefresh);
        reminderStream.addEventListener('patch', scheduleReminderRefresh);
        reminderStream.onerror = () => setFirebaseStatus('offline', 'reconnecting');
    }

    async function saveReminder(reminder) {
        if (!currentUserKey) throw new Error('Sign in before saving reminders.');
        reminder.updatedAt = new Date().toISOString();
        await firebaseRequest(`/reminders/${currentUserKey}/${reminder.id}`, { method: 'PUT', body: JSON.stringify(reminder) });
        setFirebaseStatus('online');
    }

    async function deleteReminder(id) {
        await firebaseRequest(`/reminders/${currentUserKey}/${id}`, { method: 'DELETE' });
        setFirebaseStatus('online');
    }

    function say(message, onFinished = null) {
        const sequence = ++speechSequence;
        $('assistantMessage').textContent = message;
        const finish = () => {
            if (sequence === speechSequence && typeof onFinished === 'function') onFinished();
        };
        if ('speechSynthesis' in window) {
            speechSynthesis.cancel();
            const utterance = new SpeechSynthesisUtterance(message);
            utterance.rate = 0.94;
            utterance.lang = 'en-IN';
            utterance.onend = finish;
            utterance.onerror = finish;
            speechSynthesis.speak(utterance);
        } else if (onFinished) setTimeout(finish, 250);
    }

    function isToday(reminder) {
        const day = today();
        return reminder.active && !reminder.completed && (reminder.date === day || (reminder.repeat === 'daily' && reminder.date <= day));
    }

    function isUpcoming(reminder) {
        const now = new Date();
        const current = `${localDate(now)}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
        return reminder.active && !reminder.completed && (reminder.repeat === 'daily' || `${reminder.date}T${reminder.time}` >= current);
    }

    function render() {
        const owned = reminders.filter(reminder => reminder.owner === user);
        $('todayCount').textContent = owned.filter(isToday).length;
        $('upcomingCount').textContent = owned.filter(isUpcoming).length;
        $('dailyCount').textContent = owned.filter(reminder => reminder.repeat === 'daily' && reminder.active).length;
        $('completedCount').textContent = owned.filter(reminder => reminder.completed).length;
        if (view === 'history') {
            $('listTitle').textContent = 'Reminder history';
            $('heading').textContent = 'Reminder History';
            $('reminders').innerHTML = reminderHistory.length ? reminderHistory
                .map(entry => `<div class="item"><div><span class="history-action">${safe(entry.action)}</span><strong>${safe(entry.title)}</strong><small>${safe(new Date(entry.timestamp).toLocaleString())}${entry.details ? ` · ${safe(entry.details)}` : ''}${entry.scheduledTime ? ` · Scheduled ${safe(entry.scheduledDate)} ${safe(entry.scheduledTime)}` : ''}</small></div></div>`)
                .join('') : '<p>No reminder history has been recorded yet.</p>';
            return;
        }
        const shown = view === 'today' ? owned.filter(isToday) : owned;
        $('listTitle').textContent = view === 'today' ? "Today's reminders" : view === 'all' ? 'All reminders' : 'Your reminders';
        $('heading').textContent = view === 'today' ? "Today's Reminders" : view === 'all' ? 'All Reminders' : 'Accessible Reminder Dashboard';
        $('reminders').innerHTML = shown.length ? shown
            .sort((left, right) => `${left.date}${left.time}`.localeCompare(`${right.date}${right.time}`))
            .map(reminder => `<div class="item"><div><strong>${safe(reminder.title)}</strong><small>${safe(reminder.date)} · ${safe(reminder.time)} · ${reminder.repeat === 'daily' ? 'Daily' : 'One time'} · ${reminder.completed ? 'Completed' : reminder.active ? 'Active' : 'Disabled'}</small></div><div class="actions"><button class="btn secondary" data-action="edit" data-id="${reminder.id}">Edit</button><button class="btn secondary" data-action="toggle" data-id="${reminder.id}">${reminder.active ? 'Disable' : 'Enable'}</button><button class="btn secondary" data-action="complete" data-id="${reminder.id}">Done</button><button class="btn danger" data-action="delete" data-id="${reminder.id}">Delete</button></div></div>`)
            .join('') : '<p>No reminders found. Add one using the button or your voice.</p>';
    }

    function showForm(id = null) {
        editing = id;
        const reminder = reminders.find(item => item.id === id);
        $('formHeading').textContent = reminder ? 'Edit reminder' : 'Add reminder';
        $('title').value = reminder?.title || '';
        $('date').value = reminder?.date || today();
        $('time').value = reminder?.time || '09:00';
        $('frequency').value = reminder?.repeat || 'once';
        $('reminderOverlay').classList.remove('hidden');
        $('title').focus();
    }

    function readReminders(todayOnly = false) {
        const active = reminders.filter(reminder => reminder.owner === user && reminder.active && !reminder.completed && (!todayOnly || isToday(reminder)));
        const scope = todayOnly ? ' for today' : '';
        say(active.length
            ? `You have ${active.length} active reminder${active.length === 1 ? '' : 's'}${scope}. ${active.map(reminder => `${reminder.title} at ${reminder.time}${reminder.repeat === 'daily' ? ' every day' : ''}`).join('. ')}`
            : `You have no active reminders${scope}.`);
    }

    function alertReminder(reminder) {
        pendingAcknowledgement = reminder;
        const message = `Reminder. It is ${reminder.time}. ${reminder.title}`;
        $('alertMessage').textContent = message;
        $('alertOverlay').classList.remove('hidden');
        ask(`${message}. Say acknowledge, done, or got it.`, 'alertAcknowledgement');
        if ('Notification' in window && Notification.permission === 'granted') {
            new Notification('VoiceCare Reminder', { body: message });
        }
    }

    async function acknowledgeReminder() {
        const reminder = pendingAcknowledgement;
        if (!reminder) return;
        pendingAcknowledgement = null;
        voiceState = '';
        recognition?.abort?.();
        setListeningButtons(false);
        $('alertOverlay').classList.add('hidden');
        if (reminder.id) {
            reminder.acknowledgedAt = new Date().toISOString();
            if (reminder.repeat === 'once') reminder.completed = true;
            try {
                await saveReminder(reminder);
                await recordReminderHistory(reminder, 'acknowledged', 'Reminder acknowledged by the user');
                render();
            } catch (error) {
                setFirebaseStatus('offline', error.message);
                say('The acknowledgement could not be saved. Please check the Firebase connection.');
                return;
            }
        }
        say('Reminder acknowledged.');
    }

    async function checkAlerts() {
        if (!user || pendingAcknowledgement) return;
        const now = new Date();
        const day = localDate(now);
        const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
        for (const reminder of reminders) {
            if (reminder.owner !== user || !reminder.active || reminder.completed || reminder.time !== time || (reminder.repeat === 'once' && reminder.date !== day) || (reminder.repeat === 'daily' && reminder.date > day) || reminder.lastAlert === day) continue;
            reminder.lastAlert = day;
            try {
                await saveReminder(reminder);
                await recordReminderHistory(reminder, 'alerted', 'Scheduled reminder alert shown');
                alertReminder(reminder);
                render();
            } catch (error) {
                setFirebaseStatus('offline', error.message);
            }
            break;
        }
    }

    function stopFaceCamera() {
        faceStream?.getTracks().forEach(track => track.stop());
        faceStream = null;
        $('registerFaceVideo').srcObject = null;
    }

    function stopLoginFaceCamera() {
        loginFaceStream?.getTracks().forEach(track => track.stop());
        loginFaceStream = null;
        $('loginFaceVideo').srcObject = null;
    }

    async function loadFaceModels() {
        if (!window.faceapi) throw new Error('Face recognition library could not load. Check the internet connection.');
        if (!faceModelsPromise) {
            faceModelsPromise = Promise.all([
                faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODEL_URL),
                faceapi.nets.faceLandmark68Net.loadFromUri(FACE_MODEL_URL),
                faceapi.nets.faceRecognitionNet.loadFromUri(FACE_MODEL_URL)
            ]).catch(error => {
                faceModelsPromise = null;
                throw error;
            });
        }
        return faceModelsPromise;
    }

    async function extractSingleFaceDescriptor(input) {
        await loadFaceModels();
        const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.5 });
        const faces = await faceapi.detectAllFaces(input, options).withFaceLandmarks().withFaceDescriptors();
        if (faces.length !== 1) {
            throw new Error(faces.length ? 'More than one face is visible. Keep only the account owner in view.' : 'No clear face was detected. Face the camera in good lighting.');
        }
        return Array.from(faces[0].descriptor);
    }

    async function descriptorFromStoredEnrollment(enrollment) {
        if (Array.isArray(enrollment?.descriptor) && enrollment.descriptor.length === 128) return enrollment.descriptor.map(Number);
        if (!enrollment?.imageData) return null;
        await loadFaceModels();
        const image = await faceapi.fetchImage(enrollment.imageData);
        return extractSingleFaceDescriptor(image);
    }

    function setFaceStatus(message, state = '') {
        $('faceStatus').textContent = message;
        $('faceStatus').dataset.state = state;
    }

    function resetFaceEnrollment() {
        stopFaceCamera();
        faceEnrollmentImage = '';
        faceEnrollmentDescriptor = null;
        $('registerFaceVideo').classList.add('hidden');
        $('registerFacePreview').classList.add('hidden');
        $('registerFacePreview').removeAttribute('src');
        $('startFaceCameraBtn').classList.remove('hidden');
        $('captureFaceBtn').disabled = true;
        $('captureFaceBtn').classList.remove('hidden');
        $('retakeFaceBtn').classList.add('hidden');
        setFaceStatus('Face capture is required before registration.');
    }

    async function startFaceCamera() {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access requires Chrome or Edge on HTTPS or localhost.');
        stopFaceCamera();
        faceEnrollmentImage = '';
        faceEnrollmentDescriptor = null;
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
            audio: false
        });
        faceStream = stream;
        const video = $('registerFaceVideo');
        video.srcObject = stream;
        await video.play();
        video.classList.remove('hidden');
        $('registerFacePreview').classList.add('hidden');
        $('startFaceCameraBtn').classList.add('hidden');
        $('retakeFaceBtn').classList.add('hidden');
        $('captureFaceBtn').classList.remove('hidden');
        $('captureFaceBtn').disabled = false;
        setFaceStatus('Camera ready. Look directly at the camera, then capture your face.');
    }

    async function captureRegistrationFace() {
        const video = $('registerFaceVideo');
        if (!faceStream || video.readyState < 2) {
            setFaceStatus('Camera is not ready yet. Please wait and try again.', 'error');
            return false;
        }
        const canvas = $('registerFaceCanvas');
        const context = canvas.getContext('2d');
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        setFaceStatus('Checking the captured face. The first model load may take a few seconds.');
        try {
            faceEnrollmentDescriptor = await extractSingleFaceDescriptor(canvas);
        } catch (error) {
            faceEnrollmentDescriptor = null;
            setFaceStatus(error.message, 'error');
            return false;
        }
        faceEnrollmentImage = canvas.toDataURL('image/jpeg', 0.72);
        const preview = $('registerFacePreview');
        preview.src = faceEnrollmentImage;
        preview.classList.remove('hidden');
        video.classList.add('hidden');
        stopFaceCamera();
        $('captureFaceBtn').classList.add('hidden');
        $('retakeFaceBtn').classList.remove('hidden');
        setFaceStatus('Face captured and ready to save with the account.', 'ready');
        return true;
    }

    async function startLoginFaceVerification(account, key, useVoice = false) {
        pendingLoginAccount = account;
        pendingLoginKey = key;
        pendingFaceEnrollmentMode = !account.faceEnrollment?.imageData && !account.faceEnrollment?.descriptor;
        $('loginFaceVerification').classList.remove('hidden');
        $('loginBtn').disabled = true;
        $('loginFaceStatus').dataset.state = '';
        $('loginFaceStatus').textContent = pendingFaceEnrollmentMode
            ? 'This account has no registered face. Capture one now for first-time enrollment.'
            : 'Password accepted. Look directly at the camera for face verification.';
        stopLoginFaceCamera();
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access requires Chrome or Edge on HTTPS or localhost.');
        loginFaceStream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
            audio: false
        });
        const video = $('loginFaceVideo');
        video.srcObject = loginFaceStream;
        await video.play();
        if (useVoice) {
            ask(pendingFaceEnrollmentMode
                ? 'No face was registered for this older account. Look at the camera and say capture to enroll your face.'
                : 'Password accepted. Look at the camera and say verify.', 'loginFace');
        }
    }

    function cancelFaceLogin(message = 'Face verification cancelled.') {
        stopLoginFaceCamera();
        pendingLoginAccount = null;
        pendingLoginKey = '';
        pendingFaceEnrollmentMode = false;
        voiceState = '';
        $('loginFaceVerification').classList.add('hidden');
        $('loginBtn').disabled = false;
        $('loginStatus').textContent = message;
    }

    async function verifyLoginFace() {
        if (!pendingLoginAccount || !pendingLoginKey) throw new Error('Sign in with your username and password first.');
        const video = $('loginFaceVideo');
        if (!loginFaceStream || video.readyState < 2) throw new Error('Camera is not ready yet. Please wait.');
        $('verifyLoginFaceBtn').disabled = true;
        $('loginFaceStatus').dataset.state = '';
        $('loginFaceStatus').textContent = 'Analyzing face…';
        try {
            const canvas = $('loginFaceCanvas');
            canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
            const liveDescriptor = await extractSingleFaceDescriptor(canvas);
            if (pendingFaceEnrollmentMode) {
                const imageData = canvas.toDataURL('image/jpeg', 0.72);
                const faceEnrollment = {
                    imageData,
                    descriptor: liveDescriptor,
                    mimeType: 'image/jpeg',
                    capturedAt: new Date().toISOString()
                };
                await firebaseRequest(`/users/${pendingLoginKey}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ faceEnrollment })
                });
                pendingLoginAccount.faceEnrollment = faceEnrollment;
                $('loginFaceStatus').textContent = 'Face enrolled successfully.';
            } else {
                const enrolledDescriptor = await descriptorFromStoredEnrollment(pendingLoginAccount.faceEnrollment);
                if (!enrolledDescriptor) throw new Error('This account has no usable face enrollment.');
                const distance = faceapi.euclideanDistance(enrolledDescriptor, liveDescriptor);
                if (!Number.isFinite(distance) || distance > FACE_MATCH_THRESHOLD) {
                    throw new Error('Face did not match the registered account. Try again in better lighting.');
                }
                if (!Array.isArray(pendingLoginAccount.faceEnrollment.descriptor)) {
                    await firebaseRequest(`/users/${pendingLoginKey}/faceEnrollment`, {
                        method: 'PATCH',
                        body: JSON.stringify({ descriptor: enrolledDescriptor })
                    });
                }
                $('loginFaceStatus').textContent = 'Face verified.';
            }
            $('loginFaceStatus').dataset.state = 'ready';
            const account = pendingLoginAccount;
            stopLoginFaceCamera();
            pendingLoginAccount = null;
            pendingLoginKey = '';
            pendingFaceEnrollmentMode = false;
            voiceState = '';
            $('loginFaceVerification').classList.add('hidden');
            await openDashboard(account);
        } catch (error) {
            $('loginFaceStatus').textContent = error.message;
            $('loginFaceStatus').dataset.state = 'error';
            $('loginStatus').textContent = error.message;
            say(error.message);
            throw error;
        } finally {
            $('verifyLoginFaceBtn').disabled = false;
        }
    }

    function normalizeSpokenEmail(spoken) {
        return spoken.toLowerCase()
            .replace(/\s+at(?:\s+the\s+rate)?\s+/g, '@')
            .replace(/\s+dot\s+/g, '.')
            .replace(/\s+/g, '');
    }

    function normalizeSpokenContact(spoken) {
        const numberWords = { zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };
        return spoken.toLowerCase().split(/\s+/).map(part => numberWords[part] ?? part).join('').replace(/[^\d+]/g, '');
    }

    function recognitionAlternativeScore(alternative) {
        const transcript = alternative.transcript.trim().toLowerCase();
        const words = transcript.split(/\s+/).filter(Boolean).length;
        const freeFormState = ['loginName', 'registerName', 'registerUsername', 'registerNameSpell', 'registerUsernameSpell', 'purpose'].includes(voiceState);
        let score = (Number.isFinite(alternative.confidence) ? alternative.confidence : 0) + (freeFormState ? 0 : Math.min(words * 0.035, 0.2));
        if (!voiceState && /\b(?:create|add|make|set|read|today|logout|help|remind)\b/.test(transcript)) score += 0.35;
        if (voiceState === 'time' && /\b(?:\d|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|am|pm|noon|midnight)\b/.test(transcript)) score += 0.35;
        if (['repeat', 'confirm', 'registerSaveConfirm', 'loginFace', 'loginNameConfirm', 'registerNameConfirm', 'registerUsernameConfirm', 'purposeConfirm', 'alertAcknowledgement'].includes(voiceState) && /\b(?:yes|correct|no|again|spell|once|daily|every|verify|capture|cancel|save|acknowledge|done|okay|got)\b/.test(transcript)) score += 0.35;
        return score;
    }

    function usePrimarySpeechHypothesis() {
        return ['loginName', 'registerName', 'registerUsername', 'registerNameSpell', 'registerUsernameSpell', 'purpose'].includes(voiceState);
    }

    const voiceSaidYes = text => /\b(?:yes|correct|right|okay|ok)\b/.test(text);
    const voiceSaidRetry = text => /\b(?:no|wrong|again|retry|change|incorrect)\b/.test(text);

    function parseSpokenSpelling(spoken) {
        const letterWords = {
            a: 'a', ay: 'a', alpha: 'a', b: 'b', be: 'b', bee: 'b', bravo: 'b',
            c: 'c', sea: 'c', see: 'c', charlie: 'c', d: 'd', dee: 'd', delta: 'd',
            e: 'e', echo: 'e', f: 'f', ef: 'f', foxtrot: 'f', g: 'g', gee: 'g', golf: 'g',
            h: 'h', aitch: 'h', hotel: 'h', i: 'i', eye: 'i', india: 'i', j: 'j', jay: 'j', juliet: 'j',
            k: 'k', kay: 'k', kilo: 'k', l: 'l', el: 'l', lima: 'l', m: 'm', em: 'm', mike: 'm',
            n: 'n', en: 'n', november: 'n', o: 'o', oh: 'o', oscar: 'o', p: 'p', pee: 'p', papa: 'p',
            q: 'q', cue: 'q', queue: 'q', quebec: 'q', r: 'r', are: 'r', romeo: 'r',
            s: 's', ess: 's', sierra: 's', t: 't', tea: 't', tee: 't', tango: 't',
            u: 'u', you: 'u', uniform: 'u', v: 'v', vee: 'v', victor: 'v',
            w: 'w', 'double-u': 'w', doubleyou: 'w', whiskey: 'w', x: 'x', ex: 'x', 'x-ray': 'x',
            y: 'y', why: 'y', yankee: 'y', z: 'z', zee: 'z', zed: 'z', zulu: 'z'
        };
        const cleaned = String(spoken || '').toLowerCase()
            .replace(/\b(?:spell|spelling|my name is|username is|letter)\b/g, ' ')
            .replace(/double\s+u/g, ' double-u ')
            .replace(/x\s+ray/g, ' x-ray ')
            .replace(/[^a-z\s-]/g, ' ');
        const output = [];
        for (const token of cleaned.split(/\s+/).filter(Boolean)) {
            if (token === 'space' || token === 'gap') output.push(' ');
            else if (letterWords[token]) output.push(letterWords[token]);
            else if (/^[a-z]$/.test(token)) output.push(token);
        }
        return output.join('').replace(/\s+/g, ' ').trim();
    }

    function mergeTranscriptParts(parts) {
        const merged = [];
        for (const part of parts.filter(Boolean)) {
            const incoming = part.trim().split(/\s+/);
            let overlap = 0;
            const maximum = Math.min(merged.length, incoming.length);
            for (let size = maximum; size > 0; size -= 1) {
                const tail = merged.slice(-size).join(' ').toLowerCase();
                const head = incoming.slice(0, size).join(' ').toLowerCase();
                if (tail === head) { overlap = size; break; }
            }
            merged.push(...incoming.slice(overlap));
        }
        return merged.join(' ').trim();
    }

    function parseSpokenTime(spoken) {
        let text = String(spoken || '').toLowerCase().replace(/\./g, '').replace(/o['’]?clock/g, '');
        if (/\bnoon\b/.test(text)) return '12:00';
        if (/\bmidnight\b/.test(text)) return '00:00';
        const numberWords = {
            one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
            ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
            sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
            forty: 40, fifty: 50
        };
        text = text.replace(/\b(a\s*m|p\s*m)\b/g, value => value.replace(/\s/g, ''));
        text = text.replace(new RegExp(`\\b(${Object.keys(numberWords).join('|')})\\b`, 'g'), word => String(numberWords[word]));
        const match = text.match(/\b(\d{1,2})(?:\s*[: ]\s*(\d{1,2}))?\s*(am|pm)?\b/);
        if (!match) return null;
        let hour = Number(match[1]);
        const minute = Number(match[2] || 0);
        if (match[3]) hour = (hour % 12) + (match[3] === 'pm' ? 12 : 0);
        if (hour > 23 || minute > 59) return null;
        return `${pad(hour)}:${pad(minute)}`;
    }

    function setListeningButtons(listening) {
        voiceListening = listening;
        $('listenBtn').textContent = listening ? '🎙 Listening…' : '🎙 Start listening';
        $('floatingMicBtn').classList.toggle('listening', listening);
        $('floatingMicBtn').setAttribute('aria-pressed', String(listening));
        $('floatingMicBtn').setAttribute('aria-label', listening ? 'Microphone listening' : 'Start voice assistant');
        $('floatingMicBtn').title = listening ? 'Listening…' : 'Start voice assistant';
    }

    function startContextualListening() {
        const loginVisible = !$('loginOverlay').classList.contains('hidden');
        if (loginVisible && !voiceState && !pendingLoginAccount) return $('voiceLoginBtn').click();
        startListening();
    }

    function startListening() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            setListeningButtons(false);
            return say('Speech recognition is not supported here. Please use Chrome or Edge, or type using the form.');
        }
        const session = ++listeningSession;
        recognition?.abort?.();
        speechSynthesis?.cancel();
        const committedParts = [];
        let latestChunk = '';
        let silenceTimer = null;
        let hardTimer = null;
        let stopFallbackTimer = null;
        let processedAudioStream = null;
        let processedAudioTrack = null;
        let completed = false;
        let stopRequested = false;
        const extendedFreeForm = ['loginName', 'registerName', 'registerUsername', 'registerNameSpell', 'registerUsernameSpell', 'purpose'].includes(voiceState);
        const silenceDelay = extendedFreeForm ? 2800 : 1900;
        const captureWindow = extendedFreeForm ? 15000 : 10000;
        const deadline = Date.now() + captureWindow;
        setListeningButtons(true);

        const stopProcessedAudio = () => {
            processedAudioStream?.getTracks().forEach(track => track.stop());
            processedAudioStream = null;
            processedAudioTrack = null;
        };

        const getProcessedAudioTrack = async () => {
            if (processedAudioTrack?.readyState === 'live') return processedAudioTrack;
            if (!navigator.mediaDevices?.getUserMedia) return null;
            processedAudioStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: { ideal: true },
                    noiseSuppression: { ideal: true },
                    autoGainControl: { ideal: true },
                    channelCount: { ideal: 1 }
                },
                video: false
            });
            processedAudioTrack = processedAudioStream.getAudioTracks()[0] || null;
            return processedAudioTrack;
        };

        const combinedTranscript = () => mergeTranscriptParts([...committedParts, latestChunk]);
        const finish = transcript => {
            if (completed || session !== listeningSession) return;
            completed = true;
            clearTimeout(silenceTimer);
            clearTimeout(hardTimer);
            clearTimeout(stopFallbackTimer);
            stopProcessedAudio();
            setListeningButtons(false);
            const spoken = String(transcript || '').trim();
            if (!spoken) {
                if (voiceState) {
                    voiceNoSpeechAttempts += 1;
                    if (voiceNoSpeechAttempts <= 2) {
                        return ask('I could not recognize the answer. Wait until the screen says Listening, then say it again slowly.', voiceState, true);
                    }
                    voiceNoSpeechAttempts = 0;
                    return ask('There may be too much background noise. Move closer to the microphone. I will keep listening; speak after Listening appears.', voiceState, true);
                }
                $('assistantMessage').textContent = 'Nothing was heard. Move closer to the microphone and press Start listening.';
                return;
            }
            voiceNoSpeechAttempts = 0;
            $('heard').textContent = `Heard: ${spoken}`;
            if (!$('loginOverlay').classList.contains('hidden')) $('loginStatus').textContent = `Heard: ${spoken}`;
            handleVoice(spoken);
        };

        const beginRecognition = () => {
            if (completed || session !== listeningSession) return;
            const current = new SpeechRecognition();
            recognition = current;
            latestChunk = '';
            current.lang = 'en-IN';
            current.interimResults = true;
            current.continuous = true;
            current.maxAlternatives = 10;
            if ('processLocally' in current) {
                try { current.processLocally = false; } catch (_) { /* browser controlled */ }
            }
            current.onstart = () => {
                $('heard').textContent = committedParts.length ? `Hearing: ${committedParts.join(' ')} …` : 'Listening…';
                if (!$('loginOverlay').classList.contains('hidden')) {
                    $('loginStatus').textContent = committedParts.length ? `Listening… Heard ${committedParts.join(' ')}` : 'Listening… Speak now.';
                }
            };
            current.onspeechstart = () => {
                if (!$('loginOverlay').classList.contains('hidden')) $('loginStatus').textContent = 'Voice detected… Keep speaking.';
            };
            current.onresult = event => {
                const resultParts = [];
                for (let index = 0; index < event.results.length; index += 1) {
                    const alternatives = Array.from(event.results[index]);
                    const best = usePrimarySpeechHypothesis()
                        ? alternatives[0]
                        : alternatives
                            .map(alternative => ({ alternative, score: recognitionAlternativeScore(alternative) }))
                            .sort((left, right) => right.score - left.score)[0]?.alternative;
                    if (best?.transcript.trim()) resultParts.push(best.transcript.trim());
                }
                latestChunk = resultParts.join(' ').replace(/\s+/g, ' ').trim();
                const preview = combinedTranscript();
                $('heard').textContent = preview ? `Hearing: ${preview} …` : 'Listening…';
                if (!$('loginOverlay').classList.contains('hidden')) $('loginStatus').textContent = preview ? `Hearing: ${preview} …` : 'Listening…';
                clearTimeout(silenceTimer);
                silenceTimer = setTimeout(() => {
                    stopRequested = true;
                    try { current.stop(); } catch (_) { /* already ended */ }
                    stopFallbackTimer = setTimeout(() => finish(combinedTranscript()), 700);
                }, silenceDelay);
            };
            current.onerror = event => {
                if (event.error === 'aborted' || completed || session !== listeningSession) return;
                if (event.error === 'no-speech' && combinedTranscript()) return finish(combinedTranscript());
                if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(event.error)) {
                    completed = true;
                    clearTimeout(silenceTimer);
                    clearTimeout(hardTimer);
                    stopProcessedAudio();
                    setListeningButtons(false);
                    $('assistantMessage').textContent = `Microphone error: ${event.error}. Check browser microphone permission.`;
                    if (!$('loginOverlay').classList.contains('hidden')) $('loginStatus').textContent = `Microphone error: ${event.error}. Check browser microphone permission.`;
                    return;
                }
                if (['network', 'language-not-supported'].includes(event.error)) {
                    completed = true;
                    clearTimeout(silenceTimer);
                    clearTimeout(hardTimer);
                    stopProcessedAudio();
                    setListeningButtons(false);
                    const message = event.error === 'network'
                        ? 'Speech recognition service is unavailable. Check the internet connection and try again in Chrome or Edge.'
                        : 'The browser speech service does not support the selected language.';
                    $('assistantMessage').textContent = message;
                    if (!$('loginOverlay').classList.contains('hidden')) $('loginStatus').textContent = message;
                }
            };
            current.onend = () => {
                if (session !== listeningSession) {
                    stopProcessedAudio();
                    return;
                }
                if (completed) return;
                if (latestChunk) committedParts.push(latestChunk);
                latestChunk = '';
                if (stopRequested || Date.now() >= deadline) return finish(mergeTranscriptParts(committedParts));
                setTimeout(beginRecognition, 140);
            };
            (async () => {
                let audioTrack = null;
                try { audioTrack = await getProcessedAudioTrack(); }
                catch (_) { stopProcessedAudio(); }
                if (completed || session !== listeningSession) {
                    stopProcessedAudio();
                    return;
                }
                try {
                    if (audioTrack) current.start(audioTrack);
                    else current.start();
                } catch (_) {
                    stopProcessedAudio();
                    try { current.start(); }
                    catch (_) { setTimeout(beginRecognition, 250); }
                }
            })();
        };

        hardTimer = setTimeout(() => {
            stopRequested = true;
            try { recognition?.stop(); } catch (_) { /* already ended */ }
            stopFallbackTimer = setTimeout(() => finish(combinedTranscript()), 700);
        }, captureWindow);
        beginRecognition();
    }

    function ask(message, state, preserveNoSpeechAttempts = false) {
        listeningSession += 1;
        recognition?.abort?.();
        voiceState = state;
        if (!preserveNoSpeechAttempts) voiceNoSpeechAttempts = 0;
        if (!$('loginOverlay').classList.contains('hidden')) $('loginStatus').textContent = message;
        say(message, () => setTimeout(() => {
            if (voiceState === state) startListening();
        }, 650));
    }

    async function handleVoice(spoken) {
        const text = spoken.toLowerCase();
        if (voiceState === 'alertAcknowledgement') {
            if (/\b(?:acknowledge|acknowledged|done|okay|ok|got it|complete)\b/.test(text)) return acknowledgeReminder();
            return ask('Please say acknowledge, done, or got it.', 'alertAcknowledgement');
        }
        if (voiceState === 'loginName') {
            voiceCandidate = spoken.replace(/\s+/g, '').toLowerCase();
            return ask(`I heard the username ${voiceCandidate}. Is that correct? Say yes or say again.`, 'loginNameConfirm');
        }
        if (voiceState === 'loginNameConfirm') {
            if (voiceSaidRetry(text)) return ask('Please say your username again.', 'loginName');
            if (!voiceSaidYes(text)) {
                voiceCandidate = spoken.replace(/\s+/g, '').toLowerCase();
                return ask(`I heard the username ${voiceCandidate}. Is that correct?`, 'loginNameConfirm');
            }
            $('username').value = voiceCandidate;
            return ask('Please provide your password. For privacy, typing is recommended.', 'loginPass');
        }
        if (voiceState === 'loginPass') {
            $('password').value = spoken.replace(/\s+/g, '');
            voiceState = '';
            say('Signing in now.');
            return login(true);
        }
        if (voiceState === 'loginFace') {
            if (text.includes('cancel') || text.includes('no')) return cancelFaceLogin();
            if (!text.includes('verify') && !text.includes('capture') && !text.includes('check')) {
                return ask(pendingFaceEnrollmentMode ? 'Say capture to enroll your face.' : 'Say verify when you are looking directly at the camera.', 'loginFace');
            }
            voiceState = '';
            try { await verifyLoginFace(); }
            catch (_) {
                if (pendingLoginAccount) return ask('Face verification failed. Look directly at the camera and say verify to try again, or say cancel.', 'loginFace');
            }
            return;
        }
        if (voiceState === 'registerName') {
            voiceCandidate = spoken;
            $('registerName').value = voiceCandidate;
            return ask(`I heard your name as ${voiceCandidate}. Is that correct? Say yes, say again, or say spell it.`, 'registerNameConfirm');
        }
        if (voiceState === 'registerNameConfirm') {
            if (text.includes('spell')) return ask('Spell your full name one letter at a time. Say space between names.', 'registerNameSpell');
            if (voiceSaidRetry(text)) {
                $('registerName').value = '';
                return ask('Please say your full name again, slowly.', 'registerName');
            }
            if (!voiceSaidYes(text)) {
                voiceCandidate = spoken;
                $('registerName').value = voiceCandidate;
                return ask(`I heard your name as ${voiceCandidate}. Is that correct? Say yes, again, or spell it.`, 'registerNameConfirm');
            }
            $('registerName').value = voiceCandidate;
            return ask('Please say the username you want to use.', 'registerUsername');
        }
        if (voiceState === 'registerNameSpell') {
            const spelledName = parseSpokenSpelling(spoken);
            if (spelledName.length < 2) return ask('I could not understand the spelling. Say each letter separately, and say space between names.', 'registerNameSpell');
            voiceCandidate = spelledName.replace(/\b\w/g, letter => letter.toUpperCase());
            $('registerName').value = voiceCandidate;
            return ask(`I spelled your name as ${voiceCandidate.split('').join(' ')}. Is that correct? Say yes or spell it again.`, 'registerNameConfirm');
        }
        if (voiceState === 'registerUsername') {
            voiceCandidate = spoken.replace(/\s+/g, '').toLowerCase();
            $('registerUsername').value = voiceCandidate;
            return ask(`I heard the username ${voiceCandidate}. Is that correct? Say yes, say again, or say spell it.`, 'registerUsernameConfirm');
        }
        if (voiceState === 'registerUsernameConfirm') {
            if (text.includes('spell')) return ask('Spell the username one letter at a time.', 'registerUsernameSpell');
            if (voiceSaidRetry(text)) {
                $('registerUsername').value = '';
                return ask('Please say the username again, slowly.', 'registerUsername');
            }
            if (!voiceSaidYes(text)) {
                voiceCandidate = spoken.replace(/\s+/g, '').toLowerCase();
                $('registerUsername').value = voiceCandidate;
                return ask(`I heard the username ${voiceCandidate}. Is that correct? Say yes, again, or spell it.`, 'registerUsernameConfirm');
            }
            $('registerUsername').value = voiceCandidate;
            return ask('Please say your email address. Say at and dot clearly.', 'registerEmail');
        }
        if (voiceState === 'registerUsernameSpell') {
            const spelledUsername = parseSpokenSpelling(spoken).replace(/\s+/g, '');
            if (spelledUsername.length < 2) return ask('I could not understand the spelling. Say each letter separately.', 'registerUsernameSpell');
            voiceCandidate = spelledUsername.toLowerCase();
            $('registerUsername').value = voiceCandidate;
            return ask(`I spelled the username as ${voiceCandidate.split('').join(' ')}. Is that correct? Say yes or spell it again.`, 'registerUsernameConfirm');
        }
        if (voiceState === 'registerEmail') {
            const email = normalizeSpokenEmail(spoken);
            $('registerEmail').value = email;
            if (!$('registerEmail').checkValidity()) return ask(`I heard ${email}, but it is not a valid email. Please say the email again.`, 'registerEmail');
            return ask('Please say your contact number, or say skip.', 'registerContact');
        }
        if (voiceState === 'registerContact') {
            $('registerContact').value = text.includes('skip') ? '' : normalizeSpokenContact(spoken);
            return ask('Please say a password with at least eight characters. Do not use spaces.', 'registerPassword');
        }
        if (voiceState === 'registerPassword') {
            const password = spoken.replace(/\s+/g, '');
            if (password.length < 8) return ask('That password is shorter than eight characters. Please say a longer password.', 'registerPassword');
            $('registerPassword').value = password;
            return ask('Please say the same password again to confirm it.', 'registerPasswordConfirm');
        }
        if (voiceState === 'registerPasswordConfirm') {
            const confirmation = spoken.replace(/\s+/g, '');
            $('registerConfirm').value = confirmation;
            if (confirmation !== $('registerPassword').value) {
                $('registerPassword').value = '';
                $('registerConfirm').value = '';
                return ask('The passwords did not match. Please say your password again.', 'registerPassword');
            }
            if (!faceStream && !faceEnrollmentImage) {
                try { await startFaceCamera(); }
                catch (error) {
                    setFaceStatus(error.message, 'error');
                    voiceState = '';
                    return say('I could not open the camera. Allow camera permission, then press Start camera.');
                }
            }
            return ask('Look directly at the camera and say capture when ready.', 'registerFace');
        }
        if (voiceState === 'registerFace') {
            if (text.includes('retake')) {
                try { await startFaceCamera(); }
                catch (error) { setFaceStatus(error.message, 'error'); }
                return ask('Look directly at the camera and say capture when ready.', 'registerFace');
            }
            if (!text.includes('capture') && !text.includes('take')) return ask('Say capture when you are looking directly at the camera.', 'registerFace');
            if (!await captureRegistrationFace()) return ask('The face capture was not accepted. Check the message, then say capture again.', 'registerFace');
            return ask('Your face was captured. Say yes to save the account, or say retake to capture again.', 'registerSaveConfirm');
        }
        if (voiceState === 'registerSaveConfirm') {
            if (text.includes('retake')) {
                try { await startFaceCamera(); }
                catch (error) { setFaceStatus(error.message, 'error'); }
                return ask('Look directly at the camera and say capture when ready.', 'registerFace');
            }
            if (text.includes('yes') || text.includes('save') || text.includes('confirm')) {
                voiceState = '';
                say('Saving your account now.');
                return $('registerForm').requestSubmit();
            }
            if (text.includes('no') || text.includes('cancel')) {
                voiceState = '';
                resetFaceEnrollment();
                return say('Registration cancelled.');
            }
            return ask('Say yes to save, retake for another photo, or no to cancel.', 'registerSaveConfirm');
        }
        if (voiceState === 'purpose') {
            if (/^(?:please|reminder|remainder|something|uh|um)$/i.test(spoken.trim())) {
                return ask(`I only heard ${spoken}. Please say the complete reminder purpose, for example take medicine.`, 'purpose');
            }
            voiceCandidate = spoken;
            return ask(`I heard ${voiceCandidate}. Is that correct? Say yes or say again.`, 'purposeConfirm');
        }
        if (voiceState === 'purposeConfirm') {
            if (voiceSaidRetry(text)) return ask('Please say the complete reminder purpose again.', 'purpose');
            if (!voiceSaidYes(text)) {
                voiceCandidate = spoken;
                return ask(`I heard ${voiceCandidate}. Is that correct?`, 'purposeConfirm');
            }
            draft.title = voiceCandidate;
            return ask('At what time should I remind you? Say a time such as 8 PM.', 'time');
        }
        if (voiceState === 'time') {
            const parsedTime = parseSpokenTime(text);
            if (!parsedTime) return ask('I could not understand the time. Please say a time such as eight P M.', 'time');
            draft.time = parsedTime;
            return ask('Should I remind you once or every day?', 'repeat');
        }
        if (voiceState === 'repeat') {
            if (!/\b(?:once|one time|daily|every day)\b/.test(text)) return ask('Please say once or every day.', 'repeat');
            draft.repeat = /\b(?:daily|every day)\b/.test(text) ? 'daily' : 'once';
            draft.date = today();
            return ask(`Save reminder ${draft.title} at ${draft.time} ${draft.repeat}? Say yes or no.`, 'confirm');
        }
        if (voiceState === 'confirm') {
            if (!/\b(?:yes|save|confirm|no|cancel)\b/.test(text)) return ask('Please say yes to save the reminder, or no to cancel.', 'confirm');
            voiceState = '';
            if (/\b(?:yes|save|confirm)\b/.test(text)) {
                const reminder = { ...draft, id: makeId(), owner: user, active: true, completed: false, lastAlert: '', createdAt: new Date().toISOString() };
                try {
                    await saveReminder(reminder);
                    reminders.push(reminder);
                    await recordReminderHistory(reminder, 'created', 'Created using the voice assistant');
                    render();
                    say('Reminder saved successfully');
                } catch (error) {
                    setFirebaseStatus('offline', error.message);
                    say('The reminder could not be saved. Please check the Firebase connection.');
                }
            } else say('Reminder cancelled');
            return;
        }
        if (/\b(?:create|add|make|set)\b.*\b(?:reminder|remainder)\b/.test(text) || /\bremind me\b/.test(text) || text === 'create') {
            draft = {};
            voiceCandidate = '';
            return ask('What would you like me to remind you about?', 'purpose');
        }
        if (text.includes('today')) return readReminders(true);
        if (text.includes('read')) return readReminders(false);
        if (text.includes('logout')) return $('logout').click();
        if (text.includes('help')) return $('helpNav').click();
        say('I did not understand. Say create a reminder, read my reminders, or help.');
    }

    async function openDashboard(account) {
        stopLoginFaceCamera();
        $('loginFaceVerification').classList.add('hidden');
        pendingUser = account;
        currentUserKey = account.id || await userKey(account.username);
        user = account.username;
        await Promise.all([loadReminders(), loadReminderHistory()]);
        startReminderStream();
        $('loginOverlay').classList.add('hidden');
        $('userPill').textContent = `Signed in: ${account.name || user}`;
        $('password').value = '';
        render();
        say(`Welcome ${account.name || user}. Your reminders are synchronized live.`);
    }

    async function login(useVoiceFace = false) {
        const username = $('username').value.trim();
        const password = $('password').value;
        if (!username || !password) {
            $('loginStatus').textContent = 'Enter both username and password.';
            return;
        }
        $('loginBtn').disabled = true;
        $('loginStatus').textContent = 'Verifying credentials with Firebase…';
        try {
            const key = await userKey(username);
            const account = await firebaseRequest(`/users/${key}`);
            if (!account || account.active === false) throw new Error('Invalid username or password.');
            if (typeof account.password === 'string') {
                if (account.password !== password) throw new Error('Invalid username or password.');
            } else if (account.passwordHash && account.salt) {
                // Legacy account: verify its old hash once, then replace the hash
                // fields with the directly stored password requested by this app.
                const candidate = await derivePassword(password, account.salt, account.iterations || PASSWORD_ITERATIONS);
                if (!hashesMatch(candidate, account.passwordHash)) throw new Error('Invalid username or password.');
                await firebaseRequest(`/users/${key}`, {
                    method: 'PATCH',
                    body: JSON.stringify({
                        password,
                        passwordHash: null,
                        salt: null,
                        iterations: null,
                        algorithm: null
                    })
                });
                account.password = password;
                delete account.passwordHash;
                delete account.salt;
                delete account.iterations;
                delete account.algorithm;
            } else {
                throw new Error('Invalid username or password.');
            }
            setFirebaseStatus('online');
            $('loginStatus').textContent = 'Password verified. Face verification is required.';
            await startLoginFaceVerification(account, key, useVoiceFace);
        } catch (error) {
            pendingUser = null;
            cancelFaceLogin(error.message);
            $('loginStatus').textContent = error.message;
            if (error.message.includes('Firebase request')) setFirebaseStatus('offline', error.message);
            say(error.message);
        } finally {
            if (!pendingLoginAccount) $('loginBtn').disabled = false;
        }
    }

    async function register(event) {
        event.preventDefault();
        const name = $('registerName').value.trim();
        const username = $('registerUsername').value.trim();
        const email = $('registerEmail').value.trim();
        const contact = $('registerContact').value.trim();
        const password = $('registerPassword').value;
        if (password !== $('registerConfirm').value) {
            $('loginStatus').textContent = 'The registration passwords do not match.';
            return;
        }
        if (!faceEnrollmentImage || !Array.isArray(faceEnrollmentDescriptor)) {
            $('loginStatus').textContent = 'Capture a clear face photo before registering.';
            setFaceStatus('Face capture is required before registration.', 'error');
            $('startFaceCameraBtn').focus();
            return;
        }
        const submit = $('registerForm').querySelector('[type="submit"]');
        submit.disabled = true;
        $('loginStatus').textContent = 'Saving the account to Firebase…';
        try {
            const key = await userKey(username);
            const existing = await firebaseRequest(`/users/${key}`);
            if (existing) throw new Error('That username is already registered.');
            const account = {
                id: key,
                name,
                username,
                email,
                contact,
                password,
                faceEnrollment: {
                    imageData: faceEnrollmentImage,
                    descriptor: faceEnrollmentDescriptor,
                    mimeType: 'image/jpeg',
                    capturedAt: new Date().toISOString()
                },
                active: true,
                accessibilityPreferences: { voiceGuidance: true },
                createdAt: new Date().toISOString()
            };
            await firebaseRequest(`/users/${key}`, { method: 'PUT', body: JSON.stringify(account) });
            $('registerForm').reset();
            $('registerForm').classList.add('hidden');
            resetFaceEnrollment();
            $('username').value = username;
            $('password').value = '';
            $('loginStatus').textContent = 'Account saved to Firebase. Enter the password to sign in.';
            setFirebaseStatus('online');
            $('password').focus();
            say('Registration successful. Your account was saved. Please sign in.');
        } catch (error) {
            $('loginStatus').textContent = error.message;
            if (error.message.includes('Firebase request')) setFirebaseStatus('offline', error.message);
        } finally {
            submit.disabled = false;
        }
    }

    $('addBtn').onclick = () => showForm();
    $('cancelBtn').onclick = () => $('reminderOverlay').classList.add('hidden');
    $('reminderForm').onsubmit = async event => {
        event.preventDefault();
        const values = { title: $('title').value.trim(), date: $('date').value, time: $('time').value, repeat: $('frequency').value };
        if (!values.title) return;
        const submit = $('reminderForm').querySelector('[type="submit"]');
        submit.disabled = true;
        const historyAction = editing ? 'edited' : 'created';
        const reminder = editing
            ? { ...reminders.find(item => item.id === editing), ...values, completed: false, lastAlert: '' }
            : { ...values, id: makeId(), owner: user, active: true, completed: false, lastAlert: '', createdAt: new Date().toISOString() };
        try {
            await saveReminder(reminder);
            if (editing) reminders = reminders.map(item => item.id === reminder.id ? reminder : item);
            else reminders.push(reminder);
            await recordReminderHistory(reminder, historyAction, editing ? 'Reminder details updated' : 'Created using the reminder form');
            render();
            $('reminderOverlay').classList.add('hidden');
            say('Reminder saved successfully');
        } catch (error) {
            setFirebaseStatus('offline', error.message);
            say('The reminder could not be saved. Please check the Firebase connection.');
        } finally {
            submit.disabled = false;
        }
    };

    $('reminders').onclick = async event => {
        const button = event.target.closest('[data-action]');
        if (!button) return;
        const reminder = reminders.find(item => item.id === button.dataset.id && item.owner === user);
        if (!reminder) return;
        const action = button.dataset.action;
        if (action === 'edit') return showForm(reminder.id);
        if (action === 'delete') {
            if (!confirm('Delete this reminder?')) return;
            try {
                await deleteReminder(reminder.id);
                await recordReminderHistory(reminder, 'deleted', 'Reminder deleted by the user');
                reminders = reminders.filter(item => item.id !== reminder.id);
                render();
                say('Reminder deleted');
            } catch (error) {
                setFirebaseStatus('offline', error.message);
                say('The reminder could not be deleted.');
            }
            return;
        }
        if (action === 'toggle') reminder.active = !reminder.active;
        if (action === 'complete') reminder.completed = true;
        try {
            await saveReminder(reminder);
            await recordReminderHistory(
                reminder,
                action === 'complete' ? 'completed' : reminder.active ? 'enabled' : 'disabled',
                action === 'complete' ? 'Marked completed by the user' : `Reminder ${reminder.active ? 'enabled' : 'disabled'}`
            );
            render();
        } catch (error) {
            setFirebaseStatus('offline', error.message);
            await loadReminders().catch(() => {});
            say('The reminder update could not be saved.');
        }
    };

    document.querySelectorAll('[data-view]').forEach(button => {
        button.onclick = () => {
            view = button.dataset.view;
            document.querySelectorAll('[data-view]').forEach(item => item.classList.toggle('active', item === button));
            render();
        };
    });

    $('readBtn').onclick = () => readReminders(false);
    $('helpNav').onclick = () => say('You can say: create a reminder, read my reminders, what reminders do I have today, help, or logout.');
    $('stopBtn').onclick = () => {
        speechSequence += 1;
        listeningSession += 1;
        voiceState = '';
        voiceCandidate = '';
        speechSynthesis?.cancel();
        recognition?.abort?.();
        setListeningButtons(false);
        $('assistantMessage').textContent = 'Voice interaction stopped.';
    };
    $('listenBtn').onclick = startListening;
    $('floatingMicBtn').onclick = startContextualListening;
    document.addEventListener('click', event => {
        if (!event.isTrusted || voiceListening) return;
        if (event.target.closest('#stopBtn, #listenBtn, #floatingMicBtn, #voiceLoginBtn')) return;
        startContextualListening();
    });
    $('notifyBtn').onclick = async () => {
        if (!('Notification' in window)) return say('This browser does not support notifications');
        say(`Notification permission ${await Notification.requestPermission()}`);
    };
    $('testBtn').onclick = () => alertReminder({ time: new Date().toTimeString().slice(0, 5), title: 'This is a test notification' });
    $('loginBtn').onclick = () => login(false);
    $('password').addEventListener('keydown', event => { if (event.key === 'Enter') login(false); });
    $('voiceLoginBtn').onclick = () => {
        voiceCandidate = '';
        $('loginStatus').textContent = 'Voice-guided login started. Speak after the listening prompt.';
        ask('Please say your username slowly and clearly.', 'loginName');
    };
    $('acknowledgeBtn').onclick = acknowledgeReminder;
    $('showRegisterBtn').onclick = () => {
        $('registerForm').classList.remove('hidden');
        resetFaceEnrollment();
        $('registerName').focus();
    };
    $('startFaceCameraBtn').onclick = () => startFaceCamera().catch(error => setFaceStatus(error.message, 'error'));
    $('captureFaceBtn').onclick = async () => {
        if (await captureRegistrationFace() && voiceState === 'registerFace') {
            ask('Your face was captured. Say yes to save the account, or say retake to capture again.', 'registerSaveConfirm');
        }
    };
    $('verifyLoginFaceBtn').onclick = () => verifyLoginFace().catch(() => {});
    $('cancelFaceLoginBtn').onclick = () => cancelFaceLogin();
    $('retakeFaceBtn').onclick = () => startFaceCamera().catch(error => setFaceStatus(error.message, 'error'));
    $('cancelRegisterBtn').onclick = () => {
        voiceState = '';
        voiceCandidate = '';
        recognition?.abort?.();
        resetFaceEnrollment();
        $('registerForm').classList.add('hidden');
    };
    $('registerForm').onsubmit = register;
    $('logout').onclick = () => {
        reminderStream?.close();
        reminderStream = null;
        clearTimeout(refreshTimer);
        user = '';
        pendingUser = null;
        currentUserKey = '';
        reminders = [];
        reminderHistory = [];
        voiceState = '';
        voiceCandidate = '';
        pendingAcknowledgement = null;
        stopFaceCamera();
        stopLoginFaceCamera();
        $('alertOverlay').classList.add('hidden');
        $('loginOverlay').classList.remove('hidden');
        $('registerForm').classList.add('hidden');
        $('userPill').textContent = 'Signed out';
        render();
        say('You are logged out. Please sign in.');
    };

    $('date').min = today();
    render();
    checkFirebase();
    setInterval(checkAlerts, 10000);
    window.addEventListener('beforeunload', () => {
        stopFaceCamera();
        stopLoginFaceCamera();
    });
    setTimeout(() => say('Welcome to VoiceCare. Please sign in or register an account.'), 600);
})();
