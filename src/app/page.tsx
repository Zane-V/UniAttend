'use client';

import { motion } from 'framer-motion';
import { UserCog, GraduationCap, UserCheck, ShieldCheck } from 'lucide-react';
import Link from 'next/link';

export default function Home() {
  const roles = [
    {
      title: 'Admin Portal',
      description: 'One-time student registration and face-print management.',
      icon: UserCog,
      href: '/admin',
      color: 'bg-slate-900',
      textColor: 'text-white'
    },
    {
      title: 'Lecturer Dashboard',
      description: 'Create sessions, generate PINs, and view live analytics.',
      icon: GraduationCap,
      href: '/lecturer',
      color: 'bg-blue-600',
      textColor: 'text-white'
    },
    {
      title: 'Student Check-In',
      description: 'Secure biometric and GPS-verified session attendance.',
      icon: UserCheck,
      href: '/student',
      color: 'bg-emerald-500',
      textColor: 'text-white'
    }
  ];

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-6 bg-[#f8fafc]">
      <motion.div 
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="text-center mb-12"
      >
        <div className="flex items-center justify-center gap-3 mb-4">
          <div className="bg-blue-600 p-3 rounded-2xl shadow-xl shadow-blue-500/20">
            <ShieldCheck className="w-10 h-10 text-white" />
          </div>
          <h1 className="text-4xl font-bold tracking-tight text-slate-900">UniAttend</h1>
        </div>
        <p className="text-slate-500 text-lg max-w-md mx-auto">
          Next-generation biometric attendance system. Select your portal to continue.
        </p>
      </motion.div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 w-full max-w-6xl">
        {roles.map((role, index) => (
          <motion.div
            key={role.title}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: index * 0.1 }}
          >
            <Link 
              href={role.href}
              className="group block h-full bg-white p-8 rounded-3xl border border-slate-200 shadow-sm hover:shadow-2xl hover:border-blue-200 transition-all duration-500 overflow-hidden relative"
            >
              <div className={`w-14 h-14 ${role.color} ${role.textColor} rounded-2xl flex items-center justify-center mb-6 group-hover:scale-110 transition-transform duration-500`}>
                <role.icon className="w-8 h-8" />
              </div>
              <h2 className="text-2xl font-bold text-slate-900 mb-3">{role.title}</h2>
              <p className="text-slate-500 leading-relaxed">{role.description}</p>
              
              <div className="absolute -bottom-6 -right-6 opacity-5 group-hover:opacity-10 group-hover:scale-125 transition-all duration-700">
                <role.icon className="w-40 h-40" />
              </div>
            </Link>
          </motion.div>
        ))}
      </div>

      <footer className="mt-16 text-slate-400 text-sm">
        &copy; 2026 UniAttend System. All rights reserved. | <i> Zane Tech.</i>
      </footer>
    </main>
  );
}
