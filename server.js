const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const path = require('path');
const app = express();

// 1. Configuración de Webhook de Stripe (DEBE ir antes de express.json())
app.post('/stripe-webhook', express.raw({ type: 'application/json' }), (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('Error en Webhook:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        console.log('¡Pago exitoso para:', session.customer_email);
        // Aquí podrías activar la suscripción en una base de datos
    }

    res.json({ received: true });
});

// 2. Middlewares normales
app.use(express.json());

// 3. Servir archivos estáticos (ESTA ES LA PARTE QUE CORRIGE EL DISEÑO)
// Asegúrate de que tus carpetas se llamen 'public', 'css', 'js' en la raíz
app.use(express.static(path.join(__dirname, 'public')));
app.use('/css', express.static(path.join(__dirname, 'public/css')));
app.use('/js', express.static(path.join(__dirname, 'public/js')));
app.use('/images', express.static(path.join(__dirname, 'public/images')));

// 4. Rutas de navegación
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/premium', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'premium.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// 5. Ruta para crear sesión de pago
app.post('/create-checkout-session', async (req, res) => {
    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: { name: 'Plan Pro Mensual', description: 'Conversiones ilimitadas' },
                    unit_amount: 999, // $9.99
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `${req.headers.origin}/success.html`,
            cancel_url: `${req.headers.origin}/premium.html`,
        });
        res.json({ id: session.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 6. Inicio del servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor funcionando en puerto ${PORT}`);
});    Rutas Estáticas: He añadido path.join(__dirname, 'public'). Esto le dice a Render: "Busca los estilos dentro de la carpeta donde esté instalado el proyecto".

    Estructura de carpetas: Para que este código funcione, asegúrate de que en tu GitHub los archivos estén así:

        /public/index.html

        /public/premium.html

        /public/css/estilos.css (o el nombre que uses).

Pasos para aplicar el cambio:

    Guarda este código en tu archivo server.js.

    Sube los cambios a GitHub (git add ., git commit, git push).