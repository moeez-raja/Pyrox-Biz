import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyA2gKibbSJFoufZHBbTJNpUHAVrljvmWk0",
  authDomain: "moeezflow.firebaseapp.com",
  projectId: "moeezflow",
  storageBucket: "moeezflow.firebasestorage.app",
  messagingSenderId: "685730612381",
  appId: "1:685730612381:web:8540168e41bfac6c848074",
  measurementId: "G-YRHHMG5VRV"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);