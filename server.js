// ================== STEP 1: Import packages ==================
const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const bodyParser = require("body-parser");

// ================== STEP 2: Initialize Express ==================
const app = express();

// ================== STEP 3: Middleware ==================
app.use(cors());
app.use(bodyParser.json());

// ================== STEP 4: Connect to MySQL ==================
const db = mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "Mysql@1234",
  database: "canteen_system"
});

db.connect(err => {
  if (err) console.error("DB connection failed:", err);
  else console.log("Connected to MySQL ✅");
});

// ================== STEP 5: Test route ==================
app.get("/", (req, res) => {
  res.send("Canteen Backend Running ✅");
});

// ================== STEP 6: User Login ==================
app.post("/api/login", (req, res) => {
  const { regNo, password } = req.body;
  if (!regNo || !password)
    return res.status(400).json({ message: "RegNo and password required" });

  db.query(
    "SELECT regNo, name, wallet_balance FROM students WHERE regNo = ? AND password = ?",
    [regNo, password],
    (err, results) => {
      if (err) return res.status(500).json({ message: "DB error", error: err });
      if (results.length === 0) return res.status(401).json({ message: "Invalid credentials" });

      res.json({ message: "Login successful ✅", student: results[0] });
    }
  );
});

// ================== STEP 7: Fetch Menu ==================
app.get("/api/menu", (req, res) => {
  db.query(
    "SELECT item_id, name, price, availability FROM menu_items",
    (err, results) => {
      if (err) return res.status(500).json({ message: "DB error", error: err });
      res.json(results);
    }
  );
});

// ================== STEP 8: Place Order ==================
app.post("/api/order", (req, res) => {
  const { regNo, cart } = req.body;
  if (!regNo || !cart || !Array.isArray(cart) || cart.length === 0)
    return res.status(400).json({ message: "regNo and cart items required" });

  const itemIds = cart.map(i => i.item_id);

  // Step 1: Get item prices and calculate total
  db.query(
    "SELECT item_id, price FROM menu_items WHERE item_id IN (?) AND availability = TRUE",
    [itemIds],
    (err, menuResults) => {
      if (err) return res.status(500).json({ message: "DB error", error: err });
      if (menuResults.length === 0) return res.status(404).json({ message: "No items available" });

      const totalAmount = cart.reduce((sum, item) => {
        const price = menuResults.find(m => m.item_id === item.item_id)?.price || 0;
        return sum + price * (item.quantity || 1);
      }, 0);

      // Step 2: Check wallet balance
      db.query("SELECT wallet_balance FROM students WHERE regNo = ?", [regNo], (err2, studentRes) => {
        if (err2) return res.status(500).json({ message: "DB error", error: err2 });
        if (studentRes.length === 0) return res.status(404).json({ message: "Student not found" });
        if (studentRes[0].wallet_balance < totalAmount)
          return res.status(400).json({ message: "Insufficient wallet balance" });

        // Step 3: Insert order
        const orderQuery = "INSERT INTO orders (regNo, total_amount, status, order_time) VALUES (?, ?, 'Pending', NOW())";
        db.query(orderQuery, [regNo, totalAmount], (err3, orderRes) => {
          if (err3) {
            console.error("Order creation failed:", err3);
            return res.status(500).json({ message: "Order creation failed", error: err3 });
          }

          const orderId = orderRes.insertId;

          // Step 4: Insert order details
          const details = cart.map(i => {
            const price = menuResults.find(m => m.item_id === i.item_id).price;
            return [orderId, i.item_id, i.quantity || 1, price];
          });

          const detailsQuery = "INSERT INTO order_details (order_id, item_id, quantity, price_at_order) VALUES ?";
          db.query(detailsQuery, [details], (err4) => {
            if (err4) {
              console.error("Order details insertion failed:", err4);
              return res.status(500).json({ message: "Order details insertion failed", error: err4 });
            }

            // Step 5: Assign token slot
            db.query("SELECT token_id FROM token_slots WHERE status = 'Gray' LIMIT 1", (err5, tokenRes) => {
              if (err5) return res.status(500).json({ message: "Token query failed", error: err5 });
              if (tokenRes.length === 0) return res.status(500).json({ message: "No free token slots" });

              const tokenId = tokenRes[0].token_id;
              db.query(
                "UPDATE token_slots SET order_id = ?, status = 'Red', last_updated = NOW() WHERE token_id = ?",
                [orderId, tokenId],
                (err6) => {
                  if (err6) return res.status(500).json({ message: "Token assignment failed", error: err6 });

                  // Step 6: Deduct wallet balance
                  const newBalance = studentRes[0].wallet_balance - totalAmount;
                  db.query("UPDATE students SET wallet_balance = ? WHERE regNo = ?", [newBalance, regNo], (err7) => {
                    if (err7) return res.status(500).json({ message: "Wallet update failed", error: err7 });

                    // Step 7: Record wallet transaction
                    db.query(
                      "INSERT INTO wallet_transactions (regNo, amount, type) VALUES (?, ?, 'debit')",
                      [regNo, totalAmount],
                      (err8) => {
                        if (err8) return res.status(500).json({ message: "Transaction failed", error: err8 });

                        res.json({ message: "Order placed ✅", orderId, tokenId, totalAmount });
                      }
                    );
                  });
                }
              );
            });
          });
        });
      });
    }
  );
});

// ================== STEP 9: Get Order History ==================
app.get("/api/orders/:regNo", (req, res) => {
  const regNo = req.params.regNo;
  const query = `
    SELECT o.order_id, o.total_amount, o.status, o.order_time,
           m.name as item_name, od.quantity, od.price_at_order
    FROM orders o
    JOIN order_details od ON o.order_id = od.order_id
    JOIN menu_items m ON od.item_id = m.item_id
    WHERE o.regNo = ?
    ORDER BY o.order_time DESC
  `;
  db.query(query, [regNo], (err, results) => {
    if (err) return res.status(500).json({ message: "DB error", error: err });

    const orders = {};
    results.forEach(row => {
      if (!orders[row.order_id]) orders[row.order_id] = { order_id: row.order_id, total_amount: row.total_amount, status: row.status, order_time: row.order_time, items: [] };
      orders[row.order_id].items.push({ name: row.item_name, quantity: row.quantity, price: row.price_at_order });
    });

    res.json(Object.values(orders));
  });
});

// ================== STEP 10: Get Profile ==================
app.get("/api/profile/:regNo", (req, res) => {
  const regNo = req.params.regNo;
  db.query("SELECT regNo, name, wallet_balance FROM students WHERE regNo = ?", [regNo], (err, results) => {
    if (err) return res.status(500).json({ message: "DB error", error: err });
    if (results.length === 0) return res.status(404).json({ message: "Student not found" });
    res.json(results[0]);
  });
});

// ================== STEP 11: Wallet Top-Up ==================
app.post("/api/wallet/add", (req, res) => {
  const { regNo, amount } = req.body;

  if (!regNo || !amount) return res.status(400).json({ message: "regNo and amount required" });

  db.query(
    "UPDATE students SET wallet_balance = wallet_balance + ? WHERE regNo = ?",
    [amount, regNo],
    (err, result) => {
      if (err) return res.status(500).json({ message: "DB error", error: err });
      if (result.affectedRows === 0) return res.status(404).json({ message: "Student not found" });

      db.query(
        "INSERT INTO wallet_transactions (regNo, amount, type) VALUES (?, ?, 'credit')",
        [regNo, amount],
        (err2) => {
          if (err2) return res.status(500).json({ message: "Transaction failed", error: err2 });
          res.json({ message: `₹${amount} added successfully ✅` });
        }
      );
    }
  );
});

// ================== STAFF: Get menu items ==================
app.get("/api/staff/menu", (req, res) => {
  db.query("SELECT item_id, name, price, availability FROM menu_items ORDER BY name", (err, results) => {
    if (err) return res.status(500).json({ message: "DB error", error: err });
    res.json(results);
  });
});

// ================== STAFF: Update menu item availability ==================
app.put("/api/staff/menu/:itemId/availability", (req, res) => {
  const itemId = req.params.itemId;
  const { availability } = req.body; // expected boolean or 0/1

  if (availability === undefined) return res.status(400).json({ message: "availability required" });

  db.query("UPDATE menu_items SET availability = ? WHERE item_id = ?", [availability, itemId], (err, result) => {
    if (err) return res.status(500).json({ message: "DB error", error: err });
    if (result.affectedRows === 0) return res.status(404).json({ message: "Item not found" });
    res.json({ message: "Availability updated ✅", itemId, availability });
  });
});

// ================== STAFF: Get token slots ==================
app.get("/api/staff/tokens", (req, res) => {
  db.query(
    `SELECT ts.token_id, ts.order_id, ts.status, ts.last_updated, o.token_no, o.status as order_status
     FROM token_slots ts
     LEFT JOIN orders o ON ts.order_id = o.order_id
     ORDER BY ts.token_id`,
    (err, results) => {
      if (err) return res.status(500).json({ message: "DB error", error: err });
      res.json(results);
    }
  );
});

// ================== STAFF: Update token slot status ==================
app.put("/api/staff/tokens/:tokenId/status", (req, res) => {
  const tokenId = req.params.tokenId;
  const { status } = req.body; // expected 'Gray' | 'Red' | 'Green'

  if (!status) return res.status(400).json({ message: "status required" });

  db.query("UPDATE token_slots SET status = ?, last_updated = NOW() WHERE token_id = ?", [status, tokenId], (err, result) => {
    if (err) return res.status(500).json({ message: "DB error", error: err });
    if (result.affectedRows === 0) return res.status(404).json({ message: "Token slot not found" });
    res.json({ message: "Token status updated ✅", tokenId, status });
  });
});

// ================== MANAGER: Fetch Student by Scanned ID ==================
app.post("/api/manager/fetch-student", (req, res) => {
  let { scannedId } = req.body;
  if (!scannedId) {
    return res.status(400).json({ message: "scannedId is required" });
  }

  // Remove prefix if exists (e.g., BL.SC.U4CSE24142 → U4CSE24142)
  const cleanedRegNo = scannedId.replace(/^BL\.SC\./i, "");

  db.query(
    "SELECT regNo, name, wallet_balance FROM students WHERE regNo = ?",
    [cleanedRegNo],
    (err, results) => {
      if (err)
        return res.status(500).json({ message: "DB error", error: err });
      if (results.length === 0)
        return res.status(404).json({ message: "Student not found" });

      res.json({
        message: "Student fetched successfully ✅",
        student: results[0],
      });
    }
  );
});

// ================== MANAGER: Update Wallet Balance ==================
app.post("/api/manager/update-wallet", (req, res) => {
  const { regNo, amount } = req.body;

  if (!regNo || !amount) {
    return res.status(400).json({ message: "regNo and amount are required" });
  }

  db.query(
    "UPDATE students SET wallet_balance = wallet_balance + ? WHERE regNo = ?",
    [amount, regNo],
    (err, result) => {
      if (err)
        return res.status(500).json({ message: "DB error", error: err });
      if (result.affectedRows === 0)
        return res.status(404).json({ message: "Student not found" });

      db.query(
        "INSERT INTO wallet_transactions (regNo, amount, type) VALUES (?, ?, 'credit')",
        [regNo, amount],
        (err2) => {
          if (err2)
            return res.status(500).json({ message: "Transaction failed", error: err2 });

          // Fetch updated balance
          db.query(
            "SELECT wallet_balance FROM students WHERE regNo = ?",
            [regNo],
            (err3, walletRes) => {
              if (err3)
                return res.status(500).json({ message: "DB error", error: err3 });

              res.json({
                message: `₹${amount} added successfully ✅`,
                newBalance: walletRes[0].wallet_balance,
              });
            }
          );
        }
      );
    }
  );
});

// ================== STEP 12: Start Server ==================
const PORT = 5000;
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
