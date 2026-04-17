const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const db = mysql.createConnection({
    host: process.env.DB_HOST || 'db-neveria',
    port: process.env.DB_PORT || 3306,
    user: 'root',
    password: '123456',
    database: 'neveriadb'
});

db.connect((err) => {
    if (err) { console.error('Error conectando a MySQL:', err); return; }
    console.log('Conectado a MySQL - Neveria Estrada');
});

// ─────────────────────────────────────────
// PRODUCTOS
// ─────────────────────────────────────────

app.get('/productos', (req, res) => {
    db.query('SELECT * FROM productos ORDER BY categoria, nombre', (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.post('/productos', (req, res) => {
    const { nombre, categoria, precio, stock, descripcion } = req.body;
    const sql = 'INSERT INTO productos (nombre, categoria, precio, stock, descripcion) VALUES (?, ?, ?, ?, ?)';
    db.query(sql, [nombre, categoria, precio, stock, descripcion], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: result.insertId, nombre, categoria, precio, stock, descripcion });
    });
});

app.put('/productos/:id', (req, res) => {
    const { nombre, categoria, precio, stock, descripcion } = req.body;
    const sql = 'UPDATE productos SET nombre=?, categoria=?, precio=?, stock=?, descripcion=? WHERE id=?';
    db.query(sql, [nombre, categoria, precio, stock, descripcion, req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ mensaje: 'Producto actualizado' });
    });
});

app.delete('/productos/:id', (req, res) => {
    db.query('DELETE FROM productos WHERE id=?', [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ mensaje: 'Producto eliminado' });
    });
});

// ─────────────────────────────────────────
// VENTAS
// ─────────────────────────────────────────

const sqlVentas = `
  SELECT v.id, v.fecha, v.total, v.notas,
    JSON_ARRAYAGG(
      JSON_OBJECT(
        'producto', p.nombre,
        'producto_id', d.producto_id,
        'cantidad', d.cantidad,
        'precio', d.precio_unitario
      )
    ) as detalle
  FROM ventas v
  LEFT JOIN detalle_ventas d ON v.id = d.venta_id
  LEFT JOIN productos p ON d.producto_id = p.id
  GROUP BY v.id
  ORDER BY v.fecha DESC
`;

app.get('/ventas', (req, res) => {
    db.query(sqlVentas, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

// GET venta por ID
app.get('/ventas/:id', (req, res) => {
    const sql = sqlVentas.replace('ORDER BY v.fecha DESC', `HAVING v.id = ${req.params.id}`);
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        if (results.length === 0) return res.status(404).json({ error: 'Venta no encontrada' });
        res.json(results[0]);
    });
});

app.post('/ventas', (req, res) => {
    const { notas, items } = req.body;
    const total = items.reduce((sum, i) => sum + (i.cantidad * i.precio_unitario), 0);

    db.beginTransaction((err) => {
        if (err) return res.status(500).json({ error: err.message });

        db.query('INSERT INTO ventas (total, notas) VALUES (?, ?)', [total, notas], (err, result) => {
            if (err) return db.rollback(() => res.status(500).json({ error: err.message }));

            const ventaId = result.insertId;
            const detalles = items.map(i => [ventaId, i.producto_id, i.cantidad, i.precio_unitario]);

            db.query('INSERT INTO detalle_ventas (venta_id, producto_id, cantidad, precio_unitario) VALUES ?', [detalles], (err) => {
                if (err) return db.rollback(() => res.status(500).json({ error: err.message }));

                const updates = items.map(i =>
                    new Promise((resolve, reject) => {
                        db.query('UPDATE productos SET stock = stock - ? WHERE id = ?', [i.cantidad, i.producto_id], (err) => {
                            if (err) reject(err); else resolve();
                        });
                    })
                );

                Promise.all(updates)
                    .then(() => {
                        db.commit((err) => {
                            if (err) return db.rollback(() => res.status(500).json({ error: err.message }));
                            res.json({ id: ventaId, total, mensaje: 'Venta registrada' });
                        });
                    })
                    .catch((err) => db.rollback(() => res.status(500).json({ error: err.message })));
            });
        });
    });
});

// UPDATE venta
app.put('/ventas/:id', (req, res) => {
    const { notas, items } = req.body;
    const total = items.reduce((sum, i) => sum + (i.cantidad * i.precio_unitario), 0);

    db.beginTransaction((err) => {
        if (err) return res.status(500).json({ error: err.message });

        // Actualiza datos generales de la venta
        db.query('UPDATE ventas SET total=?, notas=? WHERE id=?', [total, notas, req.params.id], (err) => {
            if (err) return db.rollback(() => res.status(500).json({ error: err.message }));

            // Elimina detalle anterior
            db.query('DELETE FROM detalle_ventas WHERE venta_id=?', [req.params.id], (err) => {
                if (err) return db.rollback(() => res.status(500).json({ error: err.message }));

                // Inserta nuevo detalle
                const detalles = items.map(i => [req.params.id, i.producto_id, i.cantidad, i.precio_unitario]);
                db.query('INSERT INTO detalle_ventas (venta_id, producto_id, cantidad, precio_unitario) VALUES ?', [detalles], (err) => {
                    if (err) return db.rollback(() => res.status(500).json({ error: err.message }));

                    db.commit((err) => {
                        if (err) return db.rollback(() => res.status(500).json({ error: err.message }));
                        res.json({ mensaje: 'Venta actualizada', total });
                    });
                });
            });
        });
    });
});

// DELETE venta
app.delete('/ventas/:id', (req, res) => {
    db.beginTransaction((err) => {
        if (err) return res.status(500).json({ error: err.message });

        db.query('DELETE FROM detalle_ventas WHERE venta_id=?', [req.params.id], (err) => {
            if (err) return db.rollback(() => res.status(500).json({ error: err.message }));

            db.query('DELETE FROM ventas WHERE id=?', [req.params.id], (err) => {
                if (err) return db.rollback(() => res.status(500).json({ error: err.message }));

                db.commit((err) => {
                    if (err) return db.rollback(() => res.status(500).json({ error: err.message }));
                    res.json({ mensaje: 'Venta eliminada' });
                });
            });
        });
    });
});

// ─────────────────────────────────────────
// REPORTES
// ─────────────────────────────────────────

app.get('/reportes/top-productos', (req, res) => {
    const sql = `
    SELECT p.nombre, p.categoria,
      SUM(d.cantidad) as total_vendido,
      SUM(d.cantidad * d.precio_unitario) as ingresos
    FROM detalle_ventas d
    JOIN productos p ON d.producto_id = p.id
    GROUP BY p.id
    ORDER BY total_vendido DESC
    LIMIT 5
  `;
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

app.get('/reportes/resumen', (req, res) => {
    const sql = `
        SELECT
                (SELECT COUNT(*) FROM productos) as total_productos,
                (SELECT COUNT(*) FROM ventas) as total_ventas,
                (SELECT COALESCE(SUM(total), 0) FROM ventas) as ingresos_totales,
                (SELECT COALESCE(SUM(stock), 0) FROM productos) as stock_total
    `;
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results[0]);
    });
});

app.listen(3000, () => {
    console.log('Servidor Neveria Estrada corriendo en puerto 3000');
});