import { initializeApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';

// Replace with your Firebase project configuration
const firebaseConfig = {
    apiKey: "YOUR_API_KEY",
    authDomain: "YOUR_AUTH_DOMAIN",
    databaseURL: "YOUR_DATABASE_URL",
    projectId: "YOUR_PROJECT_ID",
    storageBucket: "YOUR_STORAGE_BUCKET",
    messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
    appId: "YOUR_APP_ID"
};

let db = null;
if (firebaseConfig.apiKey !== "YOUR_API_KEY") {
    try {
        const app = initializeApp(firebaseConfig);
        db = getDatabase(app);
    } catch (e) {
        console.error("Firebase initialization failed:", e);
    }
} else {
    console.warn("Firebase placeholders detected. Running in Offline Mode.");
}

export { db };
