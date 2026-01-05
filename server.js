require('dotenv').config();
const express = require('express');
const path = require('path');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const auth = require('basic-auth');
const fs = require('fs');
const { spawn } = require('child_process');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const expressLayouts = require('express-ejs-layouts');
const helmet = require('helmet'); // Módulo que faltaba

const app = express();
const PORT = process.env.PORT || 3000;

/**
 * ==========================================
 * SEGURIDAD Y MIDDLEWARES
 * ==========================================
 */
// Helmet ayuda a proteger la app configurando varios encabezados HTTP
app.use(helmet({
    contentSecurityPolicy: false, // Desactivado para permitir scripts externos de Stripe/Google
}));

app.set('view engine', 'ejs');
app.use(expressLayouts);
app.set('views', path.join(__dirname, 'views'));
app.set('layout', 'layout');

// Middleware para el Webhook de Stripe (Debe ir antes de express.json)
app.use((req, res, next) => {
    if (req.originalUrl === '/stripe-webhook') {
        next();
    } else {
        express.json()(req, res, next);
    }
});

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

/**
 * ==========================================
 * ADMINISTRACIÓN Y CONFIGURACIÓN
 * ==========================================
 */
const admins = {
    [process.env.ADMIN_USER]: { password: process.env.ADMIN_PASS }
};

const adminAuth = (req, res, next) => {
    const user = auth(req);
    if (!user || !admins[user.name] || admins[user.name].password !== user.pass) {
        res.set('WWW-Authenticate', 'Basic realm="Admin Access"');
        return res.status(401).send('Acceso denegado');
    }
    next();
};

const config = {
    freeLimit: 5,           
    freeMaxSize: 100 * 1024 * 1024,       
    premiumMaxSize: 2000 * 1024 * 1024,   
    cleanupInterval: 3600000 
};

const uploadsDir = path.join(__dirname, 'uploads');
const outputsDir = path.join(__dirname, 'outputs');

[uploadsDir, outputsDir].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

let premiumUsers = [];
const userStats = new Map();

const getUserStats = (ip) => {
    if (!userStats.has(ip)) userStats.set(ip, { conversions: 0, lastReset: Date.now() });
    const stats = userStats.get(ip);
    if (Date.now() - stats.lastReset > 86400000) {
        stats.conversions = 0;
        stats.lastReset = Date.now();
    }
    return stats;
};

/**
 * ==========================================
 * LIMITADORES Y MULTER
 * ==========================================
 */
const limiter = rateLimit({
    windowMs: 24 * 60 * 60 * 1000, 
    max: config.freeLimit,
    skip: (req) => premiumUsers.includes(req.ip)
});

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, `input-${uniqueSuffix}${path.extname(file.originalname)}`);
    }
});

const upload = multer({
    storage: storage,
    fileFilter: (req, file, cb) => {
        const allowed = ['video/mp4', 'video/mpeg', 'video/x-msvideo', 'video/x-matroska', 'audio/mpeg', 'audio/wav'];
        if (allowed.includes(file.mimetype)) cb(null, true);
        else cb(new Error('Formato no soportado.'));
    }
});

/**
 * ==========================================
 * RUTAS DE PAGO (STRIPE)
 * ==========================================
 */
app.post('/create-checkout-session', async (req, res) => {
    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: { name: 'Suscripción Premium' },
                    unit_amount: 999,
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `${req.protocol}://${req.get('host')}/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${req.protocol}://${req.get('host')}/premium`,
            client_reference_id: req.ip,
        });
        res.json({ id: session.id });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/stripe-webhook', express.raw({ type: 'application/json' }), (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const id = session.client_reference_id || session.customer_email;
        if (id && !premiumUsers.includes(id)) premiumUsers.push(id);
    }
    res.json({ received: true });
});

/**
 * ==========================================
 * CONVERSIÓN FFmpeg
 * ==========================================
 */
app.post('/convert', limiter, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).send('Archivo inválido.');

    const stats = getUserStats(req.ip);
    const isPremium = premiumUsers.includes(req.ip);
    const maxAllowed = isPremium ? config.premiumMaxSize : config.freeMaxSize;

    if (req.file.size > maxAllowed) {
        fs.unlinkSync(req.file.path);
        return res.status(400).send('Archivo demasiado grande.');
    }

    const outputPath = path.join(outputsDir, `converted-${Date.now()}.avi`);
    const ffmpeg = spawn('ffmpeg', ['-i', req.file.path, '-c:v', 'mpeg4', '-vtag', 'XVID', '-qscale:v', '4', outputPath]);

    ffmpeg.on('close', (code) => {
        if (code === 0) {
            stats.conversions++;
            res.download(outputPath, () => {
                if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            });
        } else {
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            res.status(500).send('Error en conversión.');
        }
    });
});

/**
 * ==========================================
 * VISTAS Y MANTENIMIENTO
 * ==========================================
 */
app.get('/', (req, res) => {
    const stats = getUserStats(req.ip);
    res.render('landing', {
        title: 'Inicio',
        conversionsLeft: config.freeLimit - stats.conversions,
        maxLimit: config.freeLimit,
        maxSize: 100
    });
});

app.get('/premium', (req, res) => {
    res.render('premium', {
        title: 'Pásate a Premium',
        stripePublicKey: process.env.STRIPE_PUBLIC_KEY
    });
});

app.get('/dashboard', adminAuth, (req, res) => {
    const total = Array.from(userStats.values()).reduce((a, b) => a + b.conversions, 0);
    res.render('dashboard', {
        title: 'Admin Panel',
        stats: { totalUsers: userStats.size, totalConversions: total, premiumCount: premiumUsers.length }
    });
});

setInterval(() => {
    const threshold = Date.now() - config.cleanupInterval;
    [uploadsDir, outputsDir].forEach(dir => {
        fs.readdir(dir, (err, files) => {
            if (err) return;
            files.forEach(f => {
                const p = path.join(dir, f);
                fs.stat(p, (err, s) => {
                    if (!err && s.mtimeMs < threshold) fs.unlink(p, () => {});
                });
            });
        });
    });
}, config.cleanupInterval);

app.listen(PORT, '0.0.0.0', () => console.log(`Servidor activo en puerto ${PORT}`));