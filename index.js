const express = require('express');
const cors = require('cors');
const port = process.env.PORT || 5000;
const app = express();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
require('dotenv').config();
// middleware
app.use(cors());
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.70yiu6o.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true,
  serverApi: ServerApiVersion.v1,
});

// jwt verify function (Middleware 01)
function verifyJWT(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).send('Unauthorized access');
  }
  const token = authHeader.split(' ')[1];
  jwt.verify(token, process.env.ACCESS_TOKEN, function (err, decoded) {
    if (err) {
      return res.status(403).send({ message: 'Forbidden access' });
    }
    req.decoded = decoded;
    next();
  }); 
}

async function run() {
  try {
    const appointmentOptionCollection = client
      .db('doctorsPortal').collection('appointmentOptions');
    const bookingsCollection = client.db('doctorsPortal').collection('bookings');
    const usersCollection = client.db('doctorsPortal').collection('users');
    const doctorsCollection = client.db('doctorsPortal').collection('doctors');
    const paymentsCollection = client.db('doctorsPortal').collection('payments');

// NOTE: make sure you use verifyAdmin after verifyJWT 76-8 06.00 (Middleware 02)
const verifyAdmin = async (req, res, next) =>{
  // console.log('Inside verifyAdmin', req.decoded.email);
  const decodedEmail = req.decoded.email;
  const query = { email: decodedEmail };
  const user = await usersCollection.findOne(query);

  if (user?.role !== 'admin') {
      return res.status(403).send({ message: 'forbidden access' })
  }
  next();
}

    // Use Aggregate to query multiple collection and then merge data
    app.get('/appointmentOptions', async (req, res) => {
      const date = req.query.date;
      // console.log(date)
      const query = {};
      const options = await appointmentOptionCollection.find(query).toArray();

      // get the bookings of the provided date
      const bookingQuery = { appointmentDate: date };
      const alreadyBooked = await bookingsCollection.find(bookingQuery).toArray();

      // code carefully :D
      options.forEach((option) => {
        const optionBooked = alreadyBooked.filter( (book) => book.treatment === option.name
        );
        const bookedSlots = optionBooked.map((book) => book.slot);
        const remainingSlots = option.slots.filter((slot) => !bookedSlots.includes(slot));
        option.slots = remainingSlots;
      });
      res.send(options);
    });
    // 
    app.get('/v2/appointmentOptions', async (req, res) => {
      const date = req.query.date;
      const options = await appointmentOptionCollection
        .aggregate([
          {
            $lookup: {
              from: 'bookings',
              localField: 'name',
              foreignField: 'treatment',
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $eq: ['$appointmentDate', date],
                    },
                  },
                },
              ],
              as: 'booked',
            },
          },
          {
            $project: {
              name: 1,
              price: 1, // 71-1
              slots: 1,
              booked: {
                $map: {
                  input: '$booked',
                  as: 'book',
                  in: '$$book.slot',
                },
              },
            },
          },
          {
            $project: {
              name: 1,
              price: 1,
              slots: {
                $setDifference: ['$slots', '$booked'],
              },
            },
          },
        ])
        .toArray();
      res.send(options);
    });

// 76-2 08.00 To get appointment name/title 
    app.get('/appointmentSpecialty', async (req, res) => {
      const query = {}
      const result = await appointmentOptionCollection.find(query).project({ name: 1 }).toArray();
      res.send(result);
  })

    /***
     * API Naming Convention
     * app.get('/bookings')
     * app.get('/bookings/:id')
     * app.post('/bookings')
     * app.patch('/bookings/:id')
     * app.delete('/bookings/:id')
     */
    // V-75-2,  - user appointment data load by user email 
    app.get('/bookings', verifyJWT, async (req, res) => {
      const email = req.query.email;
      // console.log('token', req.headers.authorization)
      const decodedEmail = req.decoded.email;
      if (email !== decodedEmail) {
        return res.status(403).send({ message: 'forbidden access' });
      }

      const query = { email: email };
      const bookings = await bookingsCollection.find(query).toArray();
      res.send(bookings);
    });
// 77-2 06.30 To get specific booking (by id)
    app.get('/bookings/:id', async (req, res) => {
      const id = req.params.id;
      const query = { _id: ObjectId(id) };
      const booking = await bookingsCollection.findOne(query);
      res.send(booking);
    }); // http://localhost:5000/v2/appointmentOptions?date=Nov%2020,%202022
    // http://localhost:5000/bookings/637a5accd04d6084718e56a1

    app.post('/bookings', async (req, res) => {
      const booking = req.body;
      console.log(booking);
      const query = {
        appointmentDate: booking.appointmentDate,
        email: booking.email,
        treatment: booking.treatment,
      };
      const alreadyBooked = await bookingsCollection.find(query).toArray();
      if (alreadyBooked.length) {
        const message = `You already have a booking on ${booking.appointmentDate}`;
        return res.send({ acknowledged: false, message });
      }

      const result = await bookingsCollection.insertOne(booking);
      res.send(result);
    });
// Stripe Payment integrate 77-6 07.20 
    app.post('/create-payment-intent', async (req, res) => {
      const booking = req.body;
      const price = booking.price;
      const amount = price * 100;

      const paymentIntent = await stripe.paymentIntents.create({
        currency: 'usd',
        amount: amount,
        payment_method_types: ['card'],
      });
      res.send({
        clientSecret: paymentIntent.client_secret,
      });
    });
//77-9
    app.post('/payments', async (req, res) => {
      const payment = req.body;
      const result = await paymentsCollection.insertOne(payment);
      const id = payment.bookingId;
      const filter = { _id: ObjectId(id) };
      const updatedDoc = {
        $set: {
          paid: true,
          transactionId: payment.transactionId,
        },
      };
      const updatedResult = await bookingsCollection.updateOne(
        filter,
        updatedDoc
      );
      res.send(result);
    });

    // user token generate 75
    app.get('/jwt', async (req, res) => {
      const email = req.query.email;
      const query = { email: email };
      const user = await usersCollection.findOne(query);
      if (user) {
        const token = jwt.sign({ email }, process.env.ACCESS_TOKEN, {
          expiresIn: '7d',
        });
        return res.send({ accessToken: token });
      }
      res.status(403).send({ accessToken: '' });
    });
    // Get all user in dashboard 75-7 06.10
    app.get('/users', async (req, res) => {
      const query = {};
      const users = await usersCollection.find(query).toArray();
      res.send(users);
    });

    // Particular Admin check api 75-9
    app.get('/users/admin/:email', async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      res.send({ isAdmin: user?.role === 'admin' });
    });

    // V-75-3 User created in backend when user signup
    app.post('/users', async (req, res) => {
      const user = req.body;
      console.log(user);
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });
    // Make admin api 75-8 
    app.put('/users/admin/:id', verifyJWT, verifyAdmin, async (req, res) => {
      // const decodedEmail = req.decoded.email;
      // const query = { email: decodedEmail };
      // const user = await usersCollection.findOne(query);
      // if (user?.role !== 'admin') {
      //   return res.status(403).send({ message: 'forbidden access' });
      // } //76-9 01.10 
      const id = req.params.id;
      const filter = { _id: ObjectId(id) };
      const options = { upsert: true };
      const updatedDoc = {
        $set: {
          role: 'admin',
        },
      };
      const result = await usersCollection.updateOne(filter, updatedDoc, options);
      res.send(result);
    });

    //  // temporary to update price field on appointment options 77-1
    //     app.get('/addPrice', async (req, res) => {
    //         const filter = {}
    //         const options = { upsert: true }
    //         const updatedDoc = {
    //             $set: {
    //                 price: 99
    //             }
    //         }
    //         const result = await appointmentOptionCollection.updateMany(filter, updatedDoc, options);
    //         res.send(result);
    //     })

// 76-5 07.00 Load data from doctors api  
    app.get('/doctors', verifyJWT, verifyAdmin, async (req, res) => {
      const query = {};
      const doctors = await doctorsCollection.find(query).toArray();
      res.send(doctors);
  })
// 76-5 01.30 Add  A Doctor that means Doctor info save to mongoDB (doctors).
  app.post('/doctors', verifyJWT, verifyAdmin, async (req, res) => {
      const doctor = req.body;
      const result = await doctorsCollection.insertOne(doctor);
      res.send(result);
  });
// 76-8 Delete Doctor form mongoDB and manage doctor ui 
  app.delete('/doctors/:id', verifyJWT, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const filter = { _id: ObjectId(id) };
      const result = await doctorsCollection.deleteOne(filter);
      res.send(result);
  })

  } finally {
  }
}
run().catch(console.log);

app.get('/', async (req, res) => {
  res.send('doctors portal server is running');
});

app.listen(port, () => console.log(`Doctors portal running on ${port}`));
