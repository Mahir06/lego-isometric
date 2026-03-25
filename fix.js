const fs = require('fs');
let c = fs.readFileSync('main.js', 'utf8');

// Replace string literal 'overcooked/rooms'
c = c.replace(/'overcooked\/rooms'/g, "`rooms/${this.roomCode}/overcooked_rooms`");

// Replace string literal 'overcooked/matching_queue'
c = c.replace(/'overcooked\/matching_queue'/g, "`rooms/${this.roomCode}/overcooked_matching_queue`");

// Replace remaining overcooked/rooms paths inside existing template literals
c = c.replace(/overcooked\/rooms/g, "rooms/${this.roomCode}/overcooked_rooms");

fs.writeFileSync('main.js', c);
console.log('done replacing');
