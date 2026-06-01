importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyAol7Oz5JSdqweqz1y1qVKkyXuj8Kq8alw",
  authDomain: "sad-budushego.firebaseapp.com",
  projectId: "sad-budushego",
  storageBucket: "sad-budushego.firebasestorage.app",
  messagingSenderId: "1018143876011",
  appId: "1:1018143876011:web:f7b2ac72c51f40fbab28ee"
});

const messaging = firebase.messaging();

// Handle background push notifications (when app is closed)
messaging.onBackgroundMessage((payload) => {
  const title = (payload.notification && payload.notification.title) || 'Управление услугами';
  const body  = (payload.notification && payload.notification.body)  || '';
  self.registration.showNotification(title, {
    body,
    icon: '/icon.png',
    badge: '/icon.png',
    tag: 'svc-update'
  });
});
