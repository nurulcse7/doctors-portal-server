const express = require('express');
const app = express();
const cors = require('cors');
const port = process.env.PORT || 5000;
require('dotenv').config();
// const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
// const jwt = require('jsonwebtoken');
// // Middleware
app.use(cors());
app.use(express.json());



app.get('/', (req, res) => {
  res.send('Nur Kitchen API Running');
});

app.listen(port, () => {
  console.log('Kitchen Server running on port', port);
});
