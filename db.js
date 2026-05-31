// Open the database
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("BatterySaverDB", 1);

    // This runs once when the database is first created
    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      // Conversations table
      if (!db.objectStoreNames.contains("conversations")) {
        const convStore = db.createObjectStore("conversations", { keyPath: "convoId" });
        convStore.createIndex("model", "model");
        convStore.createIndex("lastMessageAt", "lastMessageAt");
      }

      // Messages table
      if (!db.objectStoreNames.contains("messages")) {
        const msgStore = db.createObjectStore("messages", { keyPath: "id", autoIncrement: true });
        msgStore.createIndex("convoId", "convoId");
        msgStore.createIndex("timestamp", "timestamp");
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Save or update a conversation
async function saveConversation(data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("conversations", "readwrite");
    tx.objectStore("conversations").put(data);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Save a message log entry
async function saveMessage(data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("messages", "readwrite");
    tx.objectStore("messages").put(data);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Get all conversations
async function getAllConversations() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("conversations", "readonly");
    const request = tx.objectStore("conversations").getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Get all messages for a conversation
async function getMessages(convoId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("messages", "readonly");
    const index = tx.objectStore("messages").index("convoId");
    const request = index.getAll(convoId);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Export everything as JSON
async function exportAll() {
  const conversations = await getAllConversations();
  const db = await openDB();
  const allMessages = await new Promise((resolve, reject) => {
    const tx = db.transaction("messages", "readonly");
    const request = tx.objectStore("messages").getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return { conversations, messages: allMessages };
}