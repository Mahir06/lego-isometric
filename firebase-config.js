import { initializeApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';

// Replace with your Firebase project configuration
const firebaseConfig = {
    apiKey: "AIzaSyC5352lJRRXhFAbxRLWGQQH88Tnkrzga_g",
    authDomain: "productive-play-a2e74.firebaseapp.com",
    databaseURL: "https://productive-play-a2e74-default-rtdb.firebaseio.com",
    projectId: "productive-play-a2e74",
    storageBucket: "productive-play-a2e74.firebasestorage.app",
    messagingSenderId: "576866949571",
    appId: "1:576866949571:web:2747811b6c2a08b7a94576",
    measurementId: "G-TF8M6MZZGX"
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
