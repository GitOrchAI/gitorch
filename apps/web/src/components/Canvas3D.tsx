'use client'

import React, { useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { Environment, Float, RoundedBox, ContactShadows } from '@react-three/drei'
import * as THREE from 'three'

function AgentCube({
  position,
  delay,
  color,
}: {
  position: [number, number, number]
  delay: number
  color: string
}) {
  const meshRef = useRef<THREE.Mesh>(null)

  useFrame((state) => {
    if (meshRef.current) {
      // Gentle continuous rotation
      meshRef.current.rotation.y = Math.sin(state.clock.elapsedTime * 0.5 + delay) * 0.2
      meshRef.current.rotation.x = Math.sin(state.clock.elapsedTime * 0.3 + delay) * 0.1
    }
  })

  return (
    <Float speed={2} rotationIntensity={0.5} floatIntensity={1.5} floatingRange={[-0.2, 0.2]}>
      <RoundedBox
        args={[1.5, 1.5, 1.5]}
        radius={0.2}
        smoothness={4}
        position={position}
        ref={meshRef as any}
      >
        <meshStandardMaterial color="#0f0f15" roughness={0.1} metalness={0.9} envMapIntensity={1} />

        {/* Glowing "Eyes" / Lights */}
        <mesh position={[0.4, 0.2, 0.76]}>
          <planeGeometry args={[0.3, 0.1]} />
          <meshBasicMaterial color={color} toneMapped={false} />
        </mesh>
        <mesh position={[-0.4, 0.2, 0.76]}>
          <planeGeometry args={[0.3, 0.1]} />
          <meshBasicMaterial color={color} toneMapped={false} />
        </mesh>

        {/* Antenna / Connectors */}
        <mesh position={[0.4, 0.8, 0]}>
          <cylinderGeometry args={[0.05, 0.05, 0.3]} />
          <meshStandardMaterial color="#333" metalness={0.8} />
        </mesh>
        <mesh position={[-0.4, 0.8, 0]}>
          <cylinderGeometry args={[0.05, 0.05, 0.3]} />
          <meshStandardMaterial color="#333" metalness={0.8} />
        </mesh>
      </RoundedBox>
    </Float>
  )
}

export default function Canvas3D() {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        position: 'absolute',
        top: 0,
        left: 0,
        zIndex: 0,
        pointerEvents: 'none',
      }}
    >
      <Canvas camera={{ position: [0, 0, 8], fov: 45 }}>
        <ambientLight intensity={0.2} />

        {/* Neon Light accents */}
        <pointLight position={[5, 5, 5]} intensity={10} color="#06b6d4" />
        <pointLight position={[-5, -5, -5]} intensity={10} color="#7c3aed" />

        {/* Agent Stack */}
        <AgentCube position={[0, 2, 0]} delay={0} color="#06b6d4" />
        <AgentCube position={[0, 0, 0]} delay={1} color="#f472b6" />
        <AgentCube position={[0, -2, 0]} delay={2} color="#7c3aed" />

        <Environment preset="city" />

        <ContactShadows
          position={[0, -3.5, 0]}
          opacity={0.4}
          scale={10}
          blur={2}
          far={4}
          color="#7c3aed"
        />
      </Canvas>
    </div>
  )
}
