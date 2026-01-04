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

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración de la aplicación
app.set('view engine', 'ejs');
app.use(expressLayouts);
app.set('views', path.join(__dirname, 'views'));

// Middleware para procesar JSON (Stripe Webhook necesita el body original, ver abajo)
app.use((req, res, next) => {
    if (req.originalUrl === '/stripe-webhook') {
        next();
    } else {
        express.json()(req, res, next);
    }
});
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// --- CONFIGURACIÓN DE SEGURIDAD PARA ESTADÍSTICAS ---
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

// CONFIGURACIÓN DEL CONVERSOR
const config = {
    freeLimit: 5,           // Conversiones gratis por día
    freeMaxSize: 100,       // MB
    premiumMaxSize: 2000,   // MB
    cleanupInterval: 3600000 // 1 hora
};

// Directorios
const uploadsDir = path.join(__dirname, 'uploads');
const outputsDir = path.join(__dirname, 'outputs');

[uploadsDir, outputsDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// Almacenamiento (simulado, idealmente sería una DB)
const conversionJobs = new Map();
const userStats = new Map(); // IP -> { conversions: 0, lastReset: Date }
let premiumUsers = []; // Simulacro de DB para usuarios premium

// RATE LIMITING
const limiter = rateLimit({
    windowMs: 24 * 60 * 60 * 1000, // 24 horas
    max: config.freeLimit,
    message: 'Límite de conversiones diarias alcanzado. Actualiza a Premium para continuar.',
    keyGenerator: (req) => {
        return req.ip || req.connection.remoteAddress;
    }
});

// MULTER CONFIGURATION
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: config.freeMaxSize * 1024 * 1024 // Se ajustará dinámicamente si es premium
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = [
            'video/mp4', 'video/mpeg', 'video/quicktime',
            'video/x-msvideo', 'video/x-matroska', 'video/webm',
            'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg'
        ];
        
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Tipo de archivo no soportado. Solo videos y audios.'));
        }
    }
});

// LIMPIEZA AUTOMÁTICA
setInterval(() => {
    const oneHourAgo = Date.now() - config.cleanupInterval;
    
    [uploadsDir, outputsDir].forEach(dir => {
        fs.readdir(dir, (err, files) => {
            if (err) return;
            
            files.forEach(file => {
                const filePath = path.join(dir, file);
                fs.stat(filePath, (err, stats) => {
                    if (err) return;
                    if (stats.mtimeMs < oneHourAgo) {
                        fs.unlink(filePath, (err) => {
                            if (!err) console.log(`[LIMPIEZA] Eliminado: ${file}`);
                        });
                    }
                });
            });
        });
    });
    
    // Limpiar jobs antiguos
    for (const [jobId, job] of conversionJobs.entries()) {
        if (Date.now() - job.created > config.cleanupInterval) {
            conversionJobs.delete(jobId);
        }
    }
    
    console.log(`[LIMPIEZA] Archivos antiguos eliminados`);
}, config.cleanupInterval);

// MIDDLEWARE: Logging
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
});

// HELPER: Verificar usuario premium (ahora usa la 'DB' simulada)
const isPremiumUser = (req) => {
    const userIdentifier = req.ip || req.connection.remoteAddress;
    // En un sistema real, usarías un ID de usuario de una DB, no solo la IP.
    return premiumUsers.includes(userIdentifier);
};

// HELPER: Obtener stats del usuario
const getUserStats = (ip) => {
    if (!userStats.has(ip)) {
        userStats.set(ip, {
            conversions: 0,
            lastReset: Date.now()
        });
    }
    
    const stats = userStats.get(ip);
    const now = Date.now();
    
    // Reset diario
    if (now - stats.lastReset > 24 * 60 * 60 * 1000) {
        stats.conversions = 0;
        stats.lastReset = now;
    }
    
    return stats;
};

// --- RUTAS DE MONETIZACIÓN ---

// 1. Crear sesión de pago
app.post('/create-checkout-session', async (req, res) => {
    const { priceId } = req.body; // Recibe el ID del precio de Stripe

    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price: priceId, // ID de precio creado en tu dashboard de Stripe
                quantity: 1,
            }],
            mode: 'subscription',
            success_url: `${req.protocol}://${req.get('host')}/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${req.protocol}://${req.get('host')}/premium`,
            client_reference_id: req.ip || req.connection.remoteAddress, // Usar IP para referencia en este ejemplo
            customer_email: req.body.customerEmail, // Opcional, si tienes el email del usuario
        });
        res.json({ id: session.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 2. Webhook de Stripe (Para confirmar el pago automáticamente)
app.post('/stripe-webhook', express.raw({ type: 'application/json' }), (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error(`Webhook Error: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        // Aquí guardas en tu base de datos que el usuario es Premium
        // En un caso real, deberías asociar esto a un ID de usuario registrado, no solo a la IP o email.
        const premiumIdentifier = session.client_reference_id || session.customer_email; // Usar la IP o el email
        if (premiumIdentifier && !premiumUsers.includes(premiumIdentifier)) {
            premiumUsers.push(premiumIdentifier);
            console.log(`Usuario Premium activado: ${premiumIdentifier}`);
        }
    }

    res.json({ received: true });
});

// --- RUTAS DE VISTAS ---

app.get('/', (req, res) => {
    const userIP = req.ip || req.connection.remoteAddress;
    const stats = getUserStats(userIP);
    res.render('landing', {
        title: 'Landing Page Profesional',
        conversionsLeft: config.freeLimit - stats.conversions,
        maxLimit: config.freeLimit,
        maxSize: config.freeMaxSize
    });
});

app.get('/conversor', (req, res) => {
    const userIP = req.ip || req.connection.remoteAddress;
    const stats = getUserStats(userIP);
    const isPremium = isPremiumUser(req);
    
    res.render('public_converter', {
        title: 'Conversor de Video Público',
        conversionsLeft: isPremium ? 'Ilimitadas' : config.freeLimit - stats.conversions,
        maxSize: isPremium ? config.premiumMaxSize : config.freeMaxSize,
        isPremium: isPremium
    });
});

app.get('/premium', (req, res) => {
    res.render('premium', {
        title: 'Plan Premium',
        freeLimit: config.freeLimit,
        freeSize: config.freeMaxSize,
        premiumSize: config.premiumMaxSize,
        stripePublicKey: process.env.STRIPE_PUBLIC_KEY,
        layout: false // Re-deshabilitar el layout para esta vista
    });
});

app.get('/terminos', (req, res) => {
    res.render('terms', { title: 'Términos de Servicio' });
});

app.get('/privacidad', (req, res) => {
    res.render('privacy', { title: 'Política de Privacidad' });
});

app.get('/dashboard', adminAuth, (req, res) => {
    const totalConversions = Array.from(userStats.values())
        .reduce((sum, stat) => sum + stat.conversions, 0);
    const activeJobs = conversionJobs.size;
    const totalUsers = userStats.size;

    res.render('dashboard', {
        title: 'Panel de Estadísticas',
        stats: {
            totalUsers,
            totalConversions,
            activeJobs,
            averagePerUser: totalUsers > 0 ? (totalConversions / totalUsers).toFixed(2) : 0,
            premiumUsersCount: premiumUsers.length
        }
    });
});

app.get('/stats', adminAuth, (req, res) => {
    const totalConversions = Array.from(userStats.values())
        .reduce((sum, stat) => sum + stat.conversions, 0);
    const activeJobs = conversionJobs.size;
    const totalUsers = userStats.size;

    res.json({
        totalUsers,
        totalConversions,
        activeJobs,
        averagePerUser: totalUsers > 0 ? (totalConversions / totalUsers).toFixed(2) : 0,
        premiumUsersCount: premiumUsers.length
    });
});

app.get('/success', (req, res) => {
    res.render('success', { title: 'Pago Exitoso' });
});

// Nueva ruta para verificar la sesión de Stripe
app.get('/verify-session', async (req, res) => {
    const sessionId = req.query.session_id;

    if (!sessionId) {
        return res.json({ success: false, error: 'No se proporcionó ID de sesión.' });
    }

    try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (session.payment_status === 'paid') {
            const premiumIdentifier = session.client_reference_id || session.customer_email;
            if (premiumIdentifier && !premiumUsers.includes(premiumIdentifier)) {
                premiumUsers.push(premiumIdentifier);
                console.log(`Usuario Premium confirmado a través de /verify-session: ${premiumIdentifier}`);
            }
            return res.json({ success: true });
        } else {
            return res.json({ success: false, error: 'La sesión de pago no está completada.' });
        }
    } catch (error) {
        console.error('Error al verificar la sesión de Stripe:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

// Manejo de errores Multer
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({
                error: `Archivo muy grande. Máximo ${config.freeMaxSize}MB en plan gratuito.`,
                upgradeUrl: '/premium'
            });
        }
        return res.status(400).json({ error: error.message });
    } else if (error) {
        return res.status(400).json({ error: error.message });
    }
    next();
});

// 404
app.use((req, res) => {
    res.status(404).render('404', { title: 'Página no Encontrada' });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor iniciado correctamente en el puerto ${PORT}`);
});