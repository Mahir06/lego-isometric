import { initializeApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';

// Replace with your Firebase project configuration
const firebaseConfig = {
    apiKey: "AIzaSyDJMwR8ubiKgUds5dZb2Bi09Otua9Rf37U",
    authDomain: "lego-isometric.firebaseapp.com",
    databaseURL: "https://lego-isometric-default-rtdb.firebaseio.com",
    projectId: "lego-isometric",
    storageBucket: "lego-isometric.firebasestorage.app",
    messagingSenderId: "277172742147",
    appId: "1:277172742147:web:32f87c4535ea5897344636",
    measurementId: "G-08GD9RPKR0"
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
