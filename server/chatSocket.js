// chatSocket.js (Node.js Backend)
module.exports = function (io) {
    io.on('connection', (socket) => {
      console.log(`Device/Admin connected: ${socket.id}`);
  
      // 1. Register device or admin to rooms based on ID
      socket.on('register', (data) => {
        const { id, type } = data; // type: 'admin' or 'bwc'
        socket.join('room:public'); // Kollehom b-yedkholo el-public room
  
        if (type === 'bwc') {
          socket.join(`room:camera_${id}`); // Room khassa lel-camera de waldha
          console.log(`BWC Camera ${id} joined public and private rooms.`);
        } else if (type === 'admin') {
          socket.join('room:admin');
          console.log(`Admin joined control room channels.`);
        }
      });
  
      // 2. Handle Custom Group Creation by Admin
      socket.on('create_group', (data) => {
        const { groupId, cameraIds } = data; // cameraIds: ['BWC-01', 'BWC-02']
        // Neb3at lel-cameras el-selected enha tedkhol el-group room
        cameraIds.forEach((camId) => {
          io.to(`room:camera_${camId}`).emit('join_group', { groupId });
        });
        socket.join(`room:group_${groupId}`);
        console.log(`Group chat created: ${groupId} with cameras:`, cameraIds);
      });
  
      // 3. Handle Sending Messages
      socket.on('send_message', (payload) => {
        /*
          Payload structure:
          {
            senderId: "ADMIN" or "BWC-02",
            senderName: "Control Room" or "BWC-02",
            chatType: "PUBLIC" | "PRIVATE" | "GROUP",
            targetId: "ALL" | "BWC-01" | "group_xyz",
            message: "Hello world",
            timestamp: new Date()
          }
        */
  
        if (payload.chatType === 'PUBLIC') {
          // Eb3at lel-nas kolaha (Public Chat)
          io.to('room:public').emit('receive_message', payload);
        } 
        else if (payload.chatType === 'PRIVATE') {
          // Eb3at lel-admin wel-camera el-mo3ayana bas (Private Chat)
          io.to(`room:camera_${payload.targetId}`).emit('receive_message', payload);
          io.to('room:admin').emit('receive_message', payload);
        } 
        else if (payload.chatType === 'GROUP') {
          // Eb3at lel-group room el-mo3ayana (Group Chat)
          io.to(`room:group_${payload.targetId}`).emit('receive_message', payload);
        }
      });
  
      socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
      });
    });
  };